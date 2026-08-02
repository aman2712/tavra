import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const MAX_PACKET_BYTES = 8 * 1024 * 1024;
const PACKET_FILENAME = "tavra-emirates-reimbursement-packet.pdf";

export interface ReimbursementPacketArtifact {
  filename: string;
  contentType: "application/pdf";
  bytes: Uint8Array;
  sha256: string;
}

/** Loads the visually verified demo packet without exposing it through a public URL. */
export async function loadDemoReimbursementPacket(
  path = resolve(process.cwd(), "output/pdf/tavra-reimbursement-packet.pdf"),
): Promise<ReimbursementPacketArtifact> {
  const bytes = await readFile(path);
  if (
    bytes.byteLength < 1_000 ||
    bytes.byteLength > MAX_PACKET_BYTES ||
    bytes.subarray(0, 5).toString("ascii") !== "%PDF-"
  ) {
    throw new Error("Reimbursement packet is not a valid bounded PDF");
  }
  return {
    filename: PACKET_FILENAME,
    contentType: "application/pdf",
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function emiratesReimbursementOffer(): string {
  return "Emirates says delayed checked baggage may be eligible for compensation when you contact them within 21 days of receiving it and include receipts for essential clothing or toiletries. Reply yes and I’ll send this packet to Emirates and notify your company.";
}
