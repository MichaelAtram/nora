// Pure display/reveal logic for the "Connect Hermes Desktop" card's fields.
// Kept out of the React component so it can be unit-tested with the repo's
// lightweight `tsx --test lib/*.test.ts` runner (there is no component-test
// harness). The component is a thin shell over these helpers.

// Fixed-width mask: the same regardless of the secret's real length, so the
// masked rendering never leaks how long the credential is.
export const CONNECT_FIELD_MASK = "••••••••••••";

// What a field should render: the real value, or the mask for a secret that is
// not currently revealed.
export function connectFieldDisplay(
  value: string,
  { secret = false, revealed = false }: { secret?: boolean; revealed?: boolean } = {},
): string {
  return secret && !revealed ? CONNECT_FIELD_MASK : value;
}

// A secret is revealed only while the reveal toggle was set for the EXACT
// value currently shown. Storing "the value we revealed for" (rather than a
// bare boolean) means a rotated credential — e.g. the agent is redeployed and
// the API key / dashboard password regenerate — is never shown unmasked: the
// stored value no longer matches, so the new value re-masks automatically.
export function isSecretRevealed(revealedForValue: string | null, value: string): boolean {
  return revealedForValue !== null && revealedForValue === value;
}
