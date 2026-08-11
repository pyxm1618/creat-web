export type SecretFindingKind =
  | "private_key"
  | "live_provider_token"
  | "nonempty_secret_assignment";

export type SecretFinding = {
  readonly file: string;
  readonly kind: SecretFindingKind;
  readonly line: number;
};

export type SecretScanMetadata = {
  readonly allowedAssignmentValues?: readonly string[];
};

type SecretPattern = {
  readonly kind: SecretFindingKind;
  readonly pattern: RegExp;
};

const SENSITIVE_ASSIGNMENT =
  /^\s*(?:export\s+)?(?:(?:const|let|var)\s+)?["']?(?<key>[A-Za-z0-9_-]*(?:client[_-]?secret|api[_-]?key|private[_-]?key|webhook[_-]?secret|auth[_-]?secret))["']?\s*(?:=|:)\s*(?<value>.*?)\s*$/i;
const CODE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/i;

const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    kind: "private_key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  },
  {
    kind: "live_provider_token",
    pattern: /\b(?:sk_live_|rk_live_|whsec_)[A-Za-z0-9_-]{12,}\b/g,
  },
];

function lineNumberAt(content: string, offset: number): number {
  return content.slice(0, offset).split("\n").length;
}

function assignmentValue(raw: string): { readonly quoted: boolean; readonly value: string } {
  const trimmed = raw.trim();
  const quoted = trimmed.match(/^(["'])(.*?)\1\s*(?:[,;]|\\)?\s*(?:#.*)?$/);
  if (quoted) return { quoted: true, value: quoted[2] ?? "" };
  return {
    quoted: false,
    value: trimmed
      .replace(/\s+#.*$/, "")
      .replace(/[,;]\\?\s*$/, "")
      .trim(),
  };
}

function isRuntimeReference(value: string): boolean {
  return (
    /^\$\{[A-Za-z0-9_]+\}$/.test(value) ||
    /^\$[A-Za-z0-9_]+$/.test(value) ||
    /^(?:process\.)?env\.[A-Za-z0-9_]+$/.test(value) ||
    /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?:\(.*\))?$/.test(value) ||
    /^[A-Za-z_$][\w$]*\(.*\)$/.test(value)
  );
}

export function findPotentialSecrets(
  file: string,
  content: string,
  metadata: SecretScanMetadata = {},
): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const allowedAssignmentValues = new Set(["", ...(metadata.allowedAssignmentValues ?? [])]);

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

  for (const [index, line] of content.split("\n").entries()) {
    const match = SENSITIVE_ASSIGNMENT.exec(line);
    if (!match?.groups) continue;
    const assignment = assignmentValue(match.groups.value ?? "");
    if (CODE_EXTENSION.test(file) && !assignment.quoted) continue;
    if (allowedAssignmentValues.has(assignment.value) || isRuntimeReference(assignment.value)) {
      continue;
    }
    findings.push({ file, kind: "nonempty_secret_assignment", line: index + 1 });
  }

  return findings.sort(
    (left, right) => left.line - right.line || left.kind.localeCompare(right.kind),
  );
}
