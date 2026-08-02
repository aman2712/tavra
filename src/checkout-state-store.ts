import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type CheckoutWorkflowState =
  | "offer_review"
  | "quote_review"
  | "approval_pending"
  | "merchant_checkout_pending"
  | "order_confirmed"
  | "failed"
  | "reconciliation_required"
  | "canceled";

export interface CheckoutWorkflowSnapshot<T = unknown> {
  checkoutId: string;
  caseId: string;
  chatId: string;
  state: CheckoutWorkflowState;
  payload: T;
  updatedAt: string;
}

export interface CheckoutCardReference {
  checkoutId: string;
  chatId: string;
  messageId: string;
  updatedAt: string;
}

export interface CheckoutNotification {
  checkoutId: string;
  chatId: string;
  payload: unknown;
  attempts: number;
  createdAt: string;
}

export interface MerchantCheckoutClaim {
  checkoutId: string;
  ownerId: string;
  claimedAt: string;
  leaseExpiresAt: string;
  resolvedAt: string | null;
  outcomeState: CheckoutWorkflowState | null;
}

export interface CheckoutStateStore {
  saveWorkflow<T>(snapshot: CheckoutWorkflowSnapshot<T>): Promise<void>;
  getWorkflow<T>(checkoutId: string): Promise<CheckoutWorkflowSnapshot<T> | null>;
  listWorkflows<T>(
    states?: readonly CheckoutWorkflowState[],
  ): Promise<Array<CheckoutWorkflowSnapshot<T>>>;
  saveCard(reference: CheckoutCardReference): Promise<void>;
  getCard(checkoutId: string): Promise<CheckoutCardReference | null>;
  removeCard(checkoutId: string): Promise<void>;
  enqueueNotification(notification: CheckoutNotification): Promise<void>;
  pendingNotifications(): Promise<CheckoutNotification[]>;
  markNotificationDelivered(checkoutId: string): Promise<void>;
  claimMerchantCheckout<T>(input: {
    checkoutId: string;
    ownerId: string;
    claimedAt: string;
    leaseExpiresAt: string;
  }): Promise<CheckoutWorkflowSnapshot<T> | null>;
  getMerchantCheckoutClaim(checkoutId: string): Promise<MerchantCheckoutClaim | null>;
  completeMerchantCheckout<T>(
    snapshot: CheckoutWorkflowSnapshot<T>,
    ownerId: string,
  ): Promise<boolean>;
  reconcileAbandonedMerchantCheckout<T>(
    snapshot: CheckoutWorkflowSnapshot<T>,
    observedAt: string,
  ): Promise<boolean>;
}

function requiredIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9:_-]{4,180}$/.test(normalized)) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return normalized;
}

function validTimestamp(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") throw new Error("Stored checkout payload is invalid");
  return JSON.parse(value) as unknown;
}

function workflowFromRow<T>(row: Record<string, unknown>): CheckoutWorkflowSnapshot<T> {
  return {
    checkoutId: row.checkout_id as string,
    caseId: row.case_id as string,
    chatId: row.chat_id as string,
    state: row.state as CheckoutWorkflowState,
    payload: parseJson(row.payload_json) as T,
    updatedAt: row.updated_at as string,
  };
}

/**
 * Single-node durable state for the hackathon runtime. Tables are namespaced
 * so the same WAL database can also hold Linq event revisions.
 */
export class SqliteCheckoutStateStore implements CheckoutStateStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.database.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS commerce_workflows (
        checkout_id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        state TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS commerce_workflows_chat_idx
        ON commerce_workflows(chat_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS commerce_cards (
        checkout_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL UNIQUE,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(checkout_id) REFERENCES commerce_workflows(checkout_id)
          ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS commerce_notification_outbox (
        checkout_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        FOREIGN KEY(checkout_id) REFERENCES commerce_workflows(checkout_id)
          ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS commerce_checkout_claims (
        checkout_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        resolved_at TEXT,
        outcome_state TEXT,
        FOREIGN KEY(checkout_id) REFERENCES commerce_workflows(checkout_id)
          ON DELETE CASCADE
      ) STRICT;
    `);
  }

  private immediateTransaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const result = operation();
      this.database.exec("COMMIT;");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  async saveWorkflow<T>(snapshot: CheckoutWorkflowSnapshot<T>): Promise<void> {
    const checkoutId = requiredIdentifier(snapshot.checkoutId, "Checkout ID");
    const caseId = requiredIdentifier(snapshot.caseId, "Recovery case ID");
    const chatId = requiredIdentifier(snapshot.chatId, "Chat ID");
    const updatedAt = validTimestamp(snapshot.updatedAt, "Workflow updatedAt");
    const payload = JSON.stringify(snapshot.payload);
    this.database
      .prepare(`
        INSERT INTO commerce_workflows(
          checkout_id, case_id, chat_id, state, payload_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(checkout_id) DO UPDATE SET
          case_id=excluded.case_id,
          chat_id=excluded.chat_id,
          state=excluded.state,
          payload_json=excluded.payload_json,
          updated_at=excluded.updated_at
      `)
      .run(checkoutId, caseId, chatId, snapshot.state, payload, updatedAt);
  }

  async getWorkflow<T>(checkoutId: string): Promise<CheckoutWorkflowSnapshot<T> | null> {
    const row = this.database
      .prepare(`
        SELECT checkout_id, case_id, chat_id, state, payload_json, updated_at
        FROM commerce_workflows WHERE checkout_id = ?
      `)
      .get(requiredIdentifier(checkoutId, "Checkout ID")) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return workflowFromRow<T>(row);
  }

  async listWorkflows<T>(
    states: readonly CheckoutWorkflowState[] = [],
  ): Promise<Array<CheckoutWorkflowSnapshot<T>>> {
    const rows = this.database
      .prepare(`
        SELECT checkout_id, case_id, chat_id, state, payload_json, updated_at
        FROM commerce_workflows
        ORDER BY updated_at ASC
      `)
      .all() as Array<Record<string, unknown>>;
    const allowed = new Set(states);
    return rows
      .filter(
        (row) =>
          allowed.size === 0 ||
          allowed.has(row.state as CheckoutWorkflowState),
      )
      .map((row) => workflowFromRow<T>(row));
  }

  async saveCard(reference: CheckoutCardReference): Promise<void> {
    const checkoutId = requiredIdentifier(reference.checkoutId, "Checkout ID");
    const chatId = requiredIdentifier(reference.chatId, "Chat ID");
    const messageId = requiredIdentifier(reference.messageId, "Message ID");
    const updatedAt = validTimestamp(reference.updatedAt, "Card updatedAt");
    this.database
      .prepare(`
        INSERT INTO commerce_cards(checkout_id, chat_id, message_id, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(checkout_id) DO UPDATE SET
          chat_id=excluded.chat_id,
          message_id=excluded.message_id,
          updated_at=excluded.updated_at
      `)
      .run(checkoutId, chatId, messageId, updatedAt);
  }

  async getCard(checkoutId: string): Promise<CheckoutCardReference | null> {
    const row = this.database
      .prepare(`
        SELECT checkout_id, chat_id, message_id, updated_at
        FROM commerce_cards WHERE checkout_id = ?
      `)
      .get(requiredIdentifier(checkoutId, "Checkout ID")) as
      | Record<string, unknown>
      | undefined;
    return row
      ? {
          checkoutId: row.checkout_id as string,
          chatId: row.chat_id as string,
          messageId: row.message_id as string,
          updatedAt: row.updated_at as string,
        }
      : null;
  }

  async removeCard(checkoutId: string): Promise<void> {
    this.database
      .prepare("DELETE FROM commerce_cards WHERE checkout_id = ?")
      .run(requiredIdentifier(checkoutId, "Checkout ID"));
  }

  async enqueueNotification(notification: CheckoutNotification): Promise<void> {
    const checkoutId = requiredIdentifier(notification.checkoutId, "Checkout ID");
    const chatId = requiredIdentifier(notification.chatId, "Chat ID");
    const createdAt = validTimestamp(notification.createdAt, "Notification createdAt");
    if (!Number.isInteger(notification.attempts) || notification.attempts < 0) {
      throw new Error("Notification attempts must be a non-negative integer");
    }
    this.database
      .prepare(`
        INSERT INTO commerce_notification_outbox(
          checkout_id, chat_id, payload_json, attempts, created_at, delivered_at
        ) VALUES (?, ?, ?, ?, ?, NULL)
        ON CONFLICT(checkout_id) DO UPDATE SET
          chat_id=excluded.chat_id,
          payload_json=excluded.payload_json,
          attempts=excluded.attempts,
          created_at=excluded.created_at,
          delivered_at=NULL
      `)
      .run(
        checkoutId,
        chatId,
        JSON.stringify(notification.payload),
        notification.attempts,
        createdAt,
      );
  }

  async pendingNotifications(): Promise<CheckoutNotification[]> {
    const rows = this.database
      .prepare(`
        SELECT checkout_id, chat_id, payload_json, attempts, created_at
        FROM commerce_notification_outbox
        WHERE delivered_at IS NULL
        ORDER BY created_at ASC
      `)
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      checkoutId: row.checkout_id as string,
      chatId: row.chat_id as string,
      payload: parseJson(row.payload_json),
      attempts: Number(row.attempts),
      createdAt: row.created_at as string,
    }));
  }

  async markNotificationDelivered(checkoutId: string): Promise<void> {
    this.database
      .prepare(`
        UPDATE commerce_notification_outbox
        SET delivered_at = ?
        WHERE checkout_id = ?
      `)
      .run(
        new Date().toISOString(),
        requiredIdentifier(checkoutId, "Checkout ID"),
      );
  }

  async claimMerchantCheckout<T>(input: {
    checkoutId: string;
    ownerId: string;
    claimedAt: string;
    leaseExpiresAt: string;
  }): Promise<CheckoutWorkflowSnapshot<T> | null> {
    const checkoutId = requiredIdentifier(input.checkoutId, "Checkout ID");
    const ownerId = requiredIdentifier(input.ownerId, "Checkout claim owner");
    const claimedAt = validTimestamp(input.claimedAt, "Checkout claimedAt");
    const leaseExpiresAt = validTimestamp(
      input.leaseExpiresAt,
      "Checkout leaseExpiresAt",
    );
    if (Date.parse(leaseExpiresAt) <= Date.parse(claimedAt)) {
      throw new Error("Checkout claim lease must expire after it is acquired");
    }
    return this.immediateTransaction(() => {
      const row = this.database
        .prepare(`
          SELECT checkout_id, case_id, chat_id, state, payload_json, updated_at
          FROM commerce_workflows WHERE checkout_id = ?
        `)
        .get(checkoutId) as Record<string, unknown> | undefined;
      if (!row || row.state !== "approval_pending") return null;
      const inserted = this.database
        .prepare(`
          INSERT INTO commerce_checkout_claims(
            checkout_id, owner_id, claimed_at, lease_expires_at,
            resolved_at, outcome_state
          ) VALUES (?, ?, ?, ?, NULL, NULL)
          ON CONFLICT(checkout_id) DO NOTHING
        `)
        .run(checkoutId, ownerId, claimedAt, leaseExpiresAt);
      if (Number(inserted.changes) !== 1) return null;
      const updated = this.database
        .prepare(`
          UPDATE commerce_workflows
          SET state = 'merchant_checkout_pending', updated_at = ?
          WHERE checkout_id = ? AND state = 'approval_pending'
        `)
        .run(claimedAt, checkoutId);
      if (Number(updated.changes) !== 1) {
        throw new Error("Checkout workflow changed while acquiring its merchant claim");
      }
      return {
        ...workflowFromRow<T>(row),
        state: "merchant_checkout_pending" as const,
        updatedAt: claimedAt,
      };
    });
  }

  async getMerchantCheckoutClaim(
    checkoutIdValue: string,
  ): Promise<MerchantCheckoutClaim | null> {
    const checkoutId = requiredIdentifier(checkoutIdValue, "Checkout ID");
    const row = this.database
      .prepare(`
        SELECT checkout_id, owner_id, claimed_at, lease_expires_at,
               resolved_at, outcome_state
        FROM commerce_checkout_claims WHERE checkout_id = ?
      `)
      .get(checkoutId) as Record<string, unknown> | undefined;
    return row
      ? {
          checkoutId: row.checkout_id as string,
          ownerId: row.owner_id as string,
          claimedAt: row.claimed_at as string,
          leaseExpiresAt: row.lease_expires_at as string,
          resolvedAt: (row.resolved_at as string | null) ?? null,
          outcomeState:
            (row.outcome_state as CheckoutWorkflowState | null) ?? null,
        }
      : null;
  }

  async completeMerchantCheckout<T>(
    snapshot: CheckoutWorkflowSnapshot<T>,
    ownerIdValue: string,
  ): Promise<boolean> {
    if (
      snapshot.state !== "order_confirmed" &&
      snapshot.state !== "failed" &&
      snapshot.state !== "reconciliation_required"
    ) {
      throw new Error("Merchant checkout completion must use a terminal outcome state");
    }
    const checkoutId = requiredIdentifier(snapshot.checkoutId, "Checkout ID");
    const ownerId = requiredIdentifier(ownerIdValue, "Checkout claim owner");
    const caseId = requiredIdentifier(snapshot.caseId, "Recovery case ID");
    const chatId = requiredIdentifier(snapshot.chatId, "Chat ID");
    const updatedAt = validTimestamp(snapshot.updatedAt, "Workflow updatedAt");
    const payload = JSON.stringify(snapshot.payload);
    return this.immediateTransaction(() => {
      const claim = this.database
        .prepare(`
          SELECT owner_id, resolved_at FROM commerce_checkout_claims
          WHERE checkout_id = ?
        `)
        .get(checkoutId) as Record<string, unknown> | undefined;
      const workflow = this.database
        .prepare("SELECT state FROM commerce_workflows WHERE checkout_id = ?")
        .get(checkoutId) as Record<string, unknown> | undefined;
      if (
        !claim ||
        claim.owner_id !== ownerId ||
        claim.resolved_at !== null ||
        workflow?.state !== "merchant_checkout_pending"
      ) {
        return false;
      }
      const updated = this.database
        .prepare(`
          UPDATE commerce_workflows
          SET case_id = ?, chat_id = ?, state = ?, payload_json = ?, updated_at = ?
          WHERE checkout_id = ? AND state = 'merchant_checkout_pending'
        `)
        .run(
          caseId,
          chatId,
          snapshot.state,
          payload,
          updatedAt,
          checkoutId,
        );
      if (Number(updated.changes) !== 1) return false;
      this.database
        .prepare(`
          UPDATE commerce_checkout_claims
          SET resolved_at = ?, outcome_state = ?
          WHERE checkout_id = ? AND owner_id = ? AND resolved_at IS NULL
        `)
        .run(updatedAt, snapshot.state, checkoutId, ownerId);
      return true;
    });
  }

  async reconcileAbandonedMerchantCheckout<T>(
    snapshot: CheckoutWorkflowSnapshot<T>,
    observedAtValue: string,
  ): Promise<boolean> {
    if (snapshot.state !== "reconciliation_required") {
      throw new Error("Abandoned checkout must transition to reconciliation_required");
    }
    const checkoutId = requiredIdentifier(snapshot.checkoutId, "Checkout ID");
    const caseId = requiredIdentifier(snapshot.caseId, "Recovery case ID");
    const chatId = requiredIdentifier(snapshot.chatId, "Chat ID");
    const observedAt = validTimestamp(observedAtValue, "Checkout observedAt");
    const updatedAt = validTimestamp(snapshot.updatedAt, "Workflow updatedAt");
    const payload = JSON.stringify(snapshot.payload);
    return this.immediateTransaction(() => {
      const workflow = this.database
        .prepare("SELECT state FROM commerce_workflows WHERE checkout_id = ?")
        .get(checkoutId) as Record<string, unknown> | undefined;
      if (workflow?.state !== "merchant_checkout_pending") return false;
      const claim = this.database
        .prepare(`
          SELECT lease_expires_at, resolved_at FROM commerce_checkout_claims
          WHERE checkout_id = ?
        `)
        .get(checkoutId) as Record<string, unknown> | undefined;
      if (
        claim &&
        (claim.resolved_at !== null ||
          Date.parse(claim.lease_expires_at as string) > Date.parse(observedAt))
      ) {
        return false;
      }
      const updated = this.database
        .prepare(`
          UPDATE commerce_workflows
          SET case_id = ?, chat_id = ?, state = ?, payload_json = ?, updated_at = ?
          WHERE checkout_id = ? AND state = 'merchant_checkout_pending'
        `)
        .run(
          caseId,
          chatId,
          snapshot.state,
          payload,
          updatedAt,
          checkoutId,
        );
      if (Number(updated.changes) !== 1) return false;
      if (claim) {
        this.database
          .prepare(`
            UPDATE commerce_checkout_claims
            SET resolved_at = ?, outcome_state = 'reconciliation_required'
            WHERE checkout_id = ? AND resolved_at IS NULL
          `)
          .run(updatedAt, checkoutId);
      }
      return true;
    });
  }
}
