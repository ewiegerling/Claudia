# Public workspace instructions

This repository is a synthetic, public-safe OpenClaw brain template.

## Memory

- `MEMORY.md` is curated long-term memory.
- `memory/YYYY-MM-DD.md` contains chronological daily notes.
- `DREAMS.md` contains the dream journal.
- Markdown remains the source of truth; viewers must not create a parallel database.

## Safety

- Never store credentials, tokens, passwords, SSH keys, private hostnames, personal memory, or internal network details in a public repository.
- Keep the real operator profile, tools notes, memory, dreams, and session data in a private workspace.
- Before every push, run `node scripts/audit-public.mjs .` and a redacted historical secret scan.
- Publish only from a generated sanitized mirror, never from the canonical private vault.
- Keep dashboards read-only and loopback-bound unless a trusted authenticated reverse proxy is explicitly configured.
