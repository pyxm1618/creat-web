# Security policy

## Supported versions

| Starter version            | Security fixes             |
| -------------------------- | -------------------------- |
| 0.1.x                      | Supported                  |
| Earlier/unversioned copies | Manual assessment required |

Owned products are independent codebases. A fix in this starter does not automatically patch an already-created product; maintainers must follow `docs/参考/扩展与升级.md`.

## Private reporting

Do not open a public issue for a suspected vulnerability. Use this repository's private GitHub security-advisory reporting path and include affected commit/version, impact, reproduction conditions, and any evidence needed to validate the issue. If private vulnerability reporting is not enabled for the repository, contact the repository owner through an already-approved private organizational channel rather than publishing exploit details.

Do not include real credentials, production webhook bodies, payment data, private user content, database dumps, or unnecessary personal data in a report.

## Triage and handling

- **Critical:** exploitable authentication/authorization bypass, credential disclosure, arbitrary payment/credit mutation, remote code execution, or broad private-data exposure. Stop affected release/rollout, rotate exposed credentials where relevant, and prioritize containment and patch verification.
- **High:** material integrity/confidentiality failures with realistic exploitation but narrower impact. Block release until patched or explicitly mitigated.
- **Medium/Low:** bounded defense-in-depth or reliability issues. Track with an owner and verification plan; do not mislabel them as resolved before tests and affected owned projects are assessed.

For every security/platform fix, record affected modules/files, migrations, environment/provider changes, verification commands, rollback considerations, and whether owned products require a manual port or cherry-pick. Update `CHANGELOG.md` when the starter version changes.

## Disclosure

This repository does not promise a fixed public-disclosure deadline. Coordinate disclosure only after the issue is validated, affected maintainers have a practical remediation path, and disclosure will not unnecessarily increase user risk.
