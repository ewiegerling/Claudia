---
name: "openclaw-brain-viewer"
description: "Private read-only dashboards and live knowledge graphs for OpenClaw Markdown memory."
---

# OpenClaw brain viewer

Use this workflow for a visual, inspectable “brain” over an OpenClaw workspace.

## Workflow

1. Inspect the workspace, existing memory files, viewer code, deployment state, and network exposure.
2. Check OpenClaw's built-in memory and memory-wiki features before adding custom storage. Keep `MEMORY.md` and `memory/*.md` as the source of truth unless the user explicitly chooses another system.
3. Build a read-only API that loads Markdown on demand, parses small frontmatter fields, sanitizes rendered HTML, and never permits arbitrary filesystem paths.
4. Derive graph nodes and relationships from live content:
   - memory files → documents
   - headings → concepts
   - known participants → people
   - backticked paths, services, and identifiers → references
   Do not create a second graph database merely for presentation.
5. Stream file-change notifications with server-sent events. Debounce filesystem bursts, send versioned refresh events, reconnect automatically, and retain a manual fallback.
6. Keep browser assets local. Avoid public CDNs and third-party telemetry.
7. Default to loopback. Before LAN or remote exposure, inspect interfaces, listeners, firewall state, proxy placement, and existing authentication. Confirm the exact bind and port. Let an approved reverse proxy handle TLS when present.
8. Install a reversible user service only after inspecting existing service state. Bind the narrowest interface that satisfies the request.
9. Test:
   - health, memory, graph, and event endpoints
   - Markdown sanitization and path traversal rejection
   - read-only method enforcement
   - static assets and proxy `HEAD` checks
   - live refresh after an atomic memory-file change
10. Verify both the direct upstream and approved proxied URL. Record durable endpoints and architectural decisions in the appropriate workspace notes.

## Safety

- Never expose memory publicly without explicit authorization.
- Never make the viewer a memory editor by accident.
- Do not print or embed tokens, proxy credentials, or private config.
- Preserve unrelated workspace and service configuration.
- If browser automation is unavailable, report that limitation and verify API, assets, headers, and responsive structure without pretending a visual inspection occurred.
