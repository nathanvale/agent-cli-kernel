// The only ways approval or authority consumption rejects. None is an
// authority denial (a denial is `false`, a not-consumed result or `refused`).
// `consumed` states whether the item's consumption marker exists after the
// rejection: when true the approved effect must not start, the item is never
// refunded, and the caller reports the observed state under REC-1 to REC-10.
const messages = {
  // Coordination was missing, inactive or for another run or scope before
  // consumption. The item is preserved.
  "coordination-not-held": "Exclusive coordination for this item is not held.",
  // The marker became durable, then coordination was found lost.
  "coordination-lost":
    "The item was consumed, then exclusive coordination was lost. The effect must not start and the item is not refunded.",
  // The marker was created but its contents or directory entry could not be
  // flushed. Ambiguous consumption is treated as consumed.
  "durability-unconfirmed":
    "The item was consumed but its durable record could not be confirmed. The effect must not start and the item is not refunded.",
  // An operational read or store failure before any consumption.
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
