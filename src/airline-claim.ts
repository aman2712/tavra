import { createHash } from "node:crypto";

export interface AirlineClaimSubmissionRequest {
  caseId: string;
  packetHash: string;
  airlineName: string;
  airlineCode: string;
  baggageReference: string;
  totalAmount: string;
  currency: string;
}

export interface AirlineClaimSubmissionResult {
  externalClaimId: string;
  submittedAt: string;
  confirmationSha256: string;
  expectedReviewWindow: "3-5 business days";
  companyNotified: true;
}

export interface AirlineClaimSubmissionProvider {
  readonly environment: "sandbox" | "production";
  submit(
    request: AirlineClaimSubmissionRequest,
  ): Promise<AirlineClaimSubmissionResult>;
}

function compact(value: string, maximum: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maximum);
}

/**
 * Deterministic sandbox connector used only by the hackathon environment.
 * Repeating a request for the same immutable packet returns the same claim ID.
 */
export function createSandboxAirlineClaimSubmissionProvider(options: {
  now?: () => Date;
} = {}): AirlineClaimSubmissionProvider {
  const now = options.now ?? (() => new Date());
  return {
    environment: "sandbox",
    async submit(request) {
      const canonical = JSON.stringify({
        caseId: compact(request.caseId, 100),
        packetHash: compact(request.packetHash, 64).toLowerCase(),
        airlineName: compact(request.airlineName, 100),
        airlineCode: compact(request.airlineCode, 3).toUpperCase(),
        baggageReference: compact(request.baggageReference, 80),
        totalAmount: compact(request.totalAmount, 24),
        currency: compact(request.currency, 3).toUpperCase(),
      });
      const digest = createHash("sha256").update(canonical).digest("hex");
      const airlineCode = /^[A-Z0-9]{2,3}$/.test(request.airlineCode)
        ? request.airlineCode.toUpperCase()
        : "CLM";
      return {
        externalClaimId: `${airlineCode}-${digest.slice(0, 10).toUpperCase()}`,
        submittedAt: now().toISOString(),
        confirmationSha256: createHash("sha256")
          .update(`sandbox-airline-confirmation\u0000${canonical}`)
          .digest("hex"),
        expectedReviewWindow: "3-5 business days",
        companyNotified: true,
      };
    },
  };
}
