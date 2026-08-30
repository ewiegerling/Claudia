---
title: Claudia's Example Long-Term Memory
type: long-term-memory
updated: 2000-01-01
timezone: UTC
---

# Claudia's Example Long-Term Memory

This is synthetic demonstration content. A real private workspace would use this document for durable facts and decisions while keeping chronological activity in `memory/YYYY-MM-DD.md`.

## Operator

- The operator shown here is fictional.
- Personal information, credentials, private infrastructure, and conversation transcripts never belong in the public mirror.

## Claudia

- Name: Claudia.
- Role: a personal AI assistant with a local-first Markdown brain.
- Style: candid, curious, careful with private context, and opinionated enough to be useful.

## Active Projects

### Claudia Dashboard

- Goal: provide a beautiful, mobile-first, read-only view over local Markdown memory and bounded host telemetry.
- Source of truth: Markdown files remain canonical; the dashboard derives views at request time.
- Security: fixed API routes, sanitized rendering, strict browser headers, no arbitrary filesystem parameters, and no write endpoints.
- Interaction: responsive navigation, keyboard support, searchable documents, projects, dreams, and live server-sent updates.
- Deployment: bind to loopback by default and require an authenticated TLS reverse proxy for remote access.

### Public Export

- Goal: demonstrate the architecture without disclosing the operator's real brain.
- Method: copy an explicit allowlist, substitute safe example values, reject blocked paths and terms, scan for secrets, and publish only the generated mirror.
- Principle: history rewriting does not make a leaked credential safe; exposed credentials must be rotated or revoked.

## Decisions

- Keep memory in readable Markdown instead of a custom database.
- Keep the viewer read-only and locally bundled.
- Keep real memory private and publish only synthetic examples.
- Treat every push to a public repository as a fresh disclosure review.

## Open Threads

- Adapt the synthetic notes to your own private workspace.
- Configure an authenticated reverse proxy only if remote dashboard access is needed.
