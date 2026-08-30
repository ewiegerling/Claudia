# Claudia

Claudia is a public-safe reference implementation of an OpenClaw Markdown brain: an Obsidian vault, a read-only mobile dashboard, a live knowledge graph workflow, and synthetic example memory that can be replaced with your own private files.

> This repository is a sanitized public edition. It contains no live personal memory, session transcripts, credentials, SSH material, private hostnames, home-directory paths, or internal network topology.

## What is included

- An Obsidian-ready vault rooted at the repository directory.
- A synthetic `MEMORY.md`, daily note, user profile, tools file, and dream journal so the dashboard works immediately.
- A dependency-light Node dashboard with fixed read-only APIs, sanitized Markdown, server-sent events, strict browser security headers, responsive navigation, and locally hosted assets.
- The `openclaw-brain-viewer` workflow.
- A fail-closed public export and privacy audit under `scripts/`.

## Quick start

```bash
cd claudia-dashboard
npm ci
npm test
DASHBOARD_HOST=127.0.0.1 DASHBOARD_PORT=4317 npm start
```

Then open `http://127.0.0.1:4317`.

To use the vault in Obsidian, open the repository root as a vault. Install **Brain Atlas** from Obsidian's Community Plugins browser; downloaded plugin binaries are intentionally not committed here.

## Use it with real memory

Keep real `MEMORY.md`, `USER.md`, `TOOLS.md`, `DREAMS.md`, and `memory/` content in a private workspace. Treat this repository as a public template or generate a sanitized mirror with:

```bash
node scripts/export-public.mjs
node scripts/audit-public.mjs ~/.openclaw/public-mirrors/Claudia
```

Read [PUBLICATION_POLICY.md](PUBLICATION_POLICY.md) before publishing any derivative.

Enable the repository's local pre-push gate once per clone:

```bash
git config core.hooksPath .githooks
```

## Security model

The dashboard is deliberately read-only, but it renders sensitive local files and host telemetry when pointed at a real workspace. Bind it to loopback by default and put authentication plus TLS in front of any remote deployment.

No license is granted merely by making this source publicly viewable.
