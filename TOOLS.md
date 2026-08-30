# Example tools and systems

This file contains synthetic placeholders only.

## Web service

- `dashboard.example.com` → reverse proxy to `http://127.0.0.1:4317`.
- Require TLS and authentication before remote access.

## Source control

- Publish only from the sanitized mirror produced by `scripts/export-public.mjs`.
- Never commit credentials, deploy keys, host-specific paths, or private topology.
