const messages = {
  "coordination-not-held": "Exclusive coordination for this item is not held.",
  "coordination-lost":
    "The item was consumed, then exclusive coordination was lost. The effect must not start and the item is not refunded.",
  "durability-unconfirmed":
    "The item was consumed but its durable record could not be confirmed. The effect must not start and the item is not refunded.",
  "store-unavailable": "Approval authority store is unavailable.",
} as const;

export type RejectionReason = keyof typeof messages;

export class ApprovalRejection extends Error {
  readonly reason: RejectionReason;
  readonly consumed: boolean;
  constructor(reason: RejectionReason, cause?: unknown) {
    super(messages[reason], cause === undefined ? undefined : { cause });
    this.name = "ApprovalRejection";
    this.reason = reason;
    this.consumed =
      reason === "coordination-lost" || reason === "durability-unconfirmed";
  }
}
