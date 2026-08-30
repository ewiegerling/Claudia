# Public publication policy

The private OpenClaw workspace is the canonical source. This public repository is a generated, allowlisted mirror.

Before every public push:

1. Export only approved source, configuration, and synthetic example content.
2. Exclude live memory, native dream/session state, per-device Obsidian state, community-plugin binaries, runtime state, and credentials.
3. Replace internal addresses, private domains, user-home paths, and deployment-specific values with loopback or `example.com` values.
4. Run `scripts/audit-public.mjs` with the private-term blocklist.
5. Run Gitleaks with full redaction over the generated tree and its Git history.
6. Run the dashboard API/security test suite.
7. Push only from the generated mirror. Never push the canonical private vault directly to a public remote.

If a secret ever reaches Git history, rotate or revoke it first. Rewriting Git history is cleanup, not credential rotation.
