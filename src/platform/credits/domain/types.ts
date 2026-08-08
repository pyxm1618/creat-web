export type CreditSourceType =
  | "order"
  | "subscription_period"
  | "compensation"
  | "promotion"
  | "admin_adjustment";

export type CreditSource = {
  readonly type: CreditSourceType;
  readonly id: string;
};

export type CreditEntryType =
  | "grant"
  | "reserve"
  | "release"
  | "consume"
  | "expire"
  | "revoke"
  | "adjust_positive"
  | "adjust_negative";

export type CreditGrantForAllocation = {
  readonly id: string;
  readonly available: number;
  readonly grantedAt: Date;
  readonly expiresAt: Date | null;
};

export type CreditAllocation = {
  readonly grantId: string;
  readonly quantity: number;
};

export type CreditBalance = {
  readonly available: number;
  readonly reserved: number;
  readonly consumed: number;
  readonly expired: number;
  readonly revoked: number;
};

export type CreditReservationStatus = "active" | "committed" | "released" | "expired";
