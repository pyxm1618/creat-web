export function assertOwner(input: {
  readonly authenticatedUserId: string;
  readonly ownerUserId: string;
}): void {
  if (input.authenticatedUserId !== input.ownerUserId) {
    throw new Error("resource access denied");
  }
}

export function assertOperator(input: { readonly role: string | null | undefined }): void {
  if (input.role !== "operator") {
    throw new Error("operator access required");
  }
}
