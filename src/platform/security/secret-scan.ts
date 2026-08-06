export type SecretFindingKind =
  | "private_key"
  | "live_provider_token"
  | "nonempty_secret_assignment";

export type SecretFinding = {
  readonly file: string;
  readonly kind: SecretFindingKind;
  readonly line: number;
};

type SecretPattern = {
  readonly kind: SecretFindingKind;
  readonly pattern: RegExp;
};

const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    kind: "private_key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  },
  {
    kind: "live_provider_token",
    pattern: /\b(?:sk_live_|rk_live_|whsec_)[A-Za-z0-9_-]{12,}\b/g,
  },
  {
    kind: "nonempty_secret_assignment",
    pattern:
      /\b(?:[A-Z0-9_]*(?:CLIENT_SECRET|API_KEY|PRIVATE_KEY|WEBHOOK_SECRET|AUTH_SECRET))[ \t]*=[ \t]*([^\s#"'=]+)/g,
  },
];

function lineNumberAt(content: string, offset: number): number {
  return content.slice(0, offset).split("\n").length;
}

export function findPotentialSecrets(file: string, content: string): SecretFinding[] {
  const findings: SecretFinding[] = [];

  for (const { kind, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      findings.push({
        file,
        kind,
        line: lineNumberAt(content, match.index ?? 0),
      });
    }
  }

  return findings.sort(
    (left, right) => left.line - right.line || left.kind.localeCompare(right.kind),
  );
}
