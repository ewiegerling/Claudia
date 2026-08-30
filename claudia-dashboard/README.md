# Claudia Dashboard

A mobile-first, read-only cockpit for OpenClaw host telemetry, Markdown memory, projects, and dream synthesis.

## Architecture

- Node HTTP server with no frontend framework or remote browser assets.
- `MEMORY.md`, `memory/*.md`, and `DREAMS.md` remain the sources of truth.
- Fixed read-only API routes with sanitized Markdown rendering.
- Debounced server-sent events notify the browser when memory changes.
- Loopback-bound by default; an authenticated TLS reverse proxy is required for remote access.

## Commands

```bash
npm ci
npm start
npm test
npm run test:browser
npm run test:cross-browser
npm run test:a11y
npm run test:all
```

Set `DASHBOARD_TEST_URL` to audit another deployment. The example systemd unit binds the service to `127.0.0.1:4317`.
