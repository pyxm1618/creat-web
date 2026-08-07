export type AccountSubjectStatus = "active" | "deletion_pending" | "deleted";

export type AccountSubject = {
  readonly id: string;
  readonly authUserId: string | null;
  readonly status: AccountSubjectStatus;
  readonly pseudonymousKey: string;
  readonly createdAt: Date;
  readonly deletionRequestedAt: Date | null;
  readonly deletedAt: Date | null;
};

export function transitionAccountSubject(
  current: AccountSubjectStatus,
  event: "begin_deletion" | "complete_deletion",
): AccountSubjectStatus {
  if (event === "begin_deletion") {
    if (current === "active" || current === "deletion_pending") return "deletion_pending";
    throw new Error("deleted subject cannot restart deletion");
  }

  if (current === "deletion_pending" || current === "deleted") return "deleted";
  throw new Error("subject deletion must begin before completion");
}
