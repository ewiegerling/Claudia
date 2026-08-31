# Claudia Recovery

Claudia Recovery is a separate, authenticated break-glass control plane for the Claudia dashboard and OpenClaw services. It deliberately exposes only status, redacted diagnostics, and four fixed restart operations. It does not provide a shell, arbitrary unit names, file contents, restore operations, or configuration editing.

## Deployment

- Public hostname: `recovery.example.com`
- Local upstream: `http://127.0.0.1:4318`
- Runtime copy: `~/.local/lib/claudia-recovery` (outside the canonical vault)
- Audit trail: `~/.local/state/claudia-recovery/audit.jsonl`
- Credential: systemd-encrypted `~/.config/claudia-recovery/recovery-auth.cred`
- Service: `claudia-recovery.service`

The runtime copy is intentionally outside the vault so a damaged workspace does not take the recovery UI down with the dashboard. Re-deploy source files by copying `server.mjs` and `public/` to the runtime directory, then restart the service. Never commit or copy the decrypted credential into either repository.

In Nginx Proxy Manager, create a TLS Proxy Host for `recovery.example.com` pointing to scheme `http`, forward host `127.0.0.1`, port `4318`. Enable Websockets only if your global policy requires it; the portal does not use them. Keep an NPM access list in addition to the portal's own Basic authentication.

## Security model

- Every page and API except `/healthz` requires independent HTTP Basic authentication.
- Credentials are systemd-encrypted and loaded through the service credential directory.
- State-changing requests require an exact trusted origin.
- Recovery actions map to a hardcoded user-service allowlist and invoke `systemctl` without a shell.
- Diagnostics contain aggregate health, service states, Git branch/short commit/dirty count, archive directory names, and the redacted action trail only.
- Authentication failures are rate-limited; request bodies are bounded; audit logs rotate locally.
- The hardened service has no elevated capabilities and a narrow network policy.

## Development and audit

```bash
npm install
npm run test:all
npm audit --audit-level=low
```

See `AUDIT.md` for the most recent release evidence.
