export async function deleteIdentityBeforeDetach(input: {
  readonly authUserId: string | null;
  readonly deleteUser: (authUserId: string) => Promise<void>;
  readonly confirmDetached: () => Promise<void>;
}): Promise<void> {
  if (input.authUserId) await input.deleteUser(input.authUserId);
  await input.confirmDetached();
}
