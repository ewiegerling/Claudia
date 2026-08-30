---
name: "dual-repo-publisher"
description: "Audit and publish a full private vault plus a sanitized public mirror when the user says push repos."
---

# Dual repository publisher

Use when the user says **push repos** or explicitly requests both the private canonical repository and public redacted repository be updated.

## Preflight

1. Read the current repository mappings and publication paths from `TOOLS.md`; do not guess.
2. Inspect both worktrees, branches, remotes, upstreams, and remote visibility before writing.
3. Fail closed on unexpected remotes, divergence, unresolved conflicts, or a public destination attached to the canonical vault.
4. Never print credential values or private file contents in logs or responses.

## Private canonical push

1. Confirm the destination is still private with an anonymous visibility check.
2. Scan the staged tree and reachable history for tokens, passwords, credential assignments, private keys, public SSH key blocks, and other secret formats. Use Gitleaks with full redaction plus the local private-push audit.
3. Personal memory, session material, operational notes, and private topology are allowed in the private repository when the user has requested the full brain be backed up.
4. Actual credentials and SSH key material are never allowed, even in the private repository. If found, stop; rotate or revoke exposed secrets before continuing.
5. Commit the canonical vault and push only to its verified private remote.
6. Confirm the local and remote commit IDs match.

## Public sanitized push

1. Generate the public mirror with the repository's allowlisted exporter. Never copy the canonical `.git` directory or broad-copy the vault.
2. Use synthetic replacements for memory, user, dreams, tools, session data, hostnames, private domains, internal addresses, home paths, and deployment-specific values.
3. Run the public-safety audit with the private-term blocklist.
4. Run Gitleaks against both the generated tree and the complete public Git history with secrets fully redacted.
5. Run the relevant syntax, dependency, API/security, and browser/accessibility tests.
6. Commit only inside the public mirror's separate Git repository and push only to its verified public remote.
7. Verify the remote commit equals the local commit.
8. Clone anonymously into a fresh temporary directory, rerun the public-safety and secret scans, then remove the temporary clone.

## Safety

- Never push the canonical OpenClaw vault to a public remote.
- Never reuse one deploy key across repositories.
- Never use `git push --all`, `git push --mirror`, or an unqualified force push.
- If private material ever entered the public repository's object store, recreate the public repository rather than trusting a cosmetic cleanup commit.
- Record durable mapping or policy changes in memory after a successful run.
