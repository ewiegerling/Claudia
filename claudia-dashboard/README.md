# Claudia Dashboard

A mobile-first cockpit for OpenClaw host telemetry, Markdown memory, projects, dream synthesis, Brain Atlas topology, encrypted password rotation, and private local-first voice interaction.

## Architecture

- Node HTTP server with no frontend framework or remote browser assets.
- `MEMORY.md`, `memory/*.md`, and `DREAMS.md` remain the sources of truth.
- Fixed content API routes with sanitized Markdown rendering. Guarded writes are limited to password rotation and bounded same-origin voice turns.
- Debounced server-sent events notify the browser when memory changes.
- Browser microphone audio is encoded as mono 16 kHz PCM and transcribed by a loopback-only pinned `whisper.cpp` service. Only the transcript is sent to a dedicated OpenClaw session.
- Spoken replies use a normal male local browser voice when one is installed; no cloud speech API is required.
- Loopback-bound by default; an authenticated TLS reverse proxy is required for remote access.

## Local voice runtime

```bash
./scripts/install-voice-runtime.sh
systemctl --user link "$PWD/systemd/claudia-stt.service"
systemctl --user daemon-reload
systemctl --user enable --now claudia-stt.service
```

Microphone access requires HTTPS and explicit user permission. Recordings are memory-only and discarded after transcription. The typed fallback remains available when a microphone or suitable local voice is unavailable.

## Commands

```bash
npm ci
npm start
npm test
npm run test:browser
npm run test:cross-browser
npm run test:a11y
npm run audit:lighthouse
npm run test:all
```

Set `DASHBOARD_TEST_URL` to audit another deployment. The example systemd unit binds the service to `127.0.0.1:4317`.
