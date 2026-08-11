export async function runFencedCheckout<TClaim, TProviderResult, TResult>(input: {
  readonly claimWhileSubjectActive: () => Promise<TClaim>;
  readonly callProvider: (claim: TClaim) => Promise<TProviderResult>;
  readonly commitWhileSubjectActive: (
    claim: TClaim,
    providerResult: TProviderResult,
  ) => Promise<TResult>;
  readonly failClaim: (claim: TClaim) => Promise<void>;
}): Promise<TResult> {
  const claim = await input.claimWhileSubjectActive();
  try {
    const providerResult = await input.callProvider(claim);
    return await input.commitWhileSubjectActive(claim, providerResult);
  } catch (error) {
    await input.failClaim(claim);
    throw error;
  }
}
