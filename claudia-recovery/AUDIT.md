# Claudia Recovery Audit

Audit date: 2026-08-31 (America/Chicago)

## Result

The independent recovery portal passed its release gates. It is enabled, authenticated, bound only to the intended LAN interface, and running from a deployment copy outside the canonical vault.

## Application and API

- 16/16 Node unit, API, and security tests passed.
- Anonymous access is limited to the minimal `/healthz` response; pages, status, diagnostics, and actions return `401` without the independent recovery credential.
- Authentication failures are throttled and return `429` after the configured limit.
- State changes require an exact trusted origin, a bounded JSON body, and one hardcoded action name.
- Password rotation requires current-secret verification, exact confirmation, trusted same-origin intent, and a 12–128 character replacement; malformed, reused, mismatched, padded, and 11-character replacements are rejected.
- Local snapshots require authenticated same-origin intent and a fixed operation body. The server owns every path and identifier, caps storage at 20 archives, requires 1 GiB free, excludes Git objects and dependency/build caches, and rejects traversal-like identifiers.
- Snapshot integration tests created a real zstd archive and atomic SHA-256 manifest, verified it, deliberately modified the archive, and confirmed that the integrity endpoint rejected the tampered result without exposing its path.
- Unknown actions, extra properties, traversal paths, malformed JSON, oversized bodies, incorrect content types, and unsupported methods fail closed.
- The server uses `execFile` without a shell and never accepts a browser-provided command, unit name, or filesystem path.
- Diagnostics exclude credentials, authorization data, environment variables, private keys, user-home paths, and file content.
- CSP, HSTS, frame denial, MIME sniffing denial, same-origin isolation, no-store caching, referrer policy, and restrictive permissions policy are present on HTML and JSON.
- Runtime dependencies: none. `npm audit --audit-level=low` reported zero vulnerabilities in development dependencies.

## Browser, mobile, and accessibility

- Chromium passed at 1440×900, 390×844, and the 320×780 reflow floor with no horizontal overflow, duplicate IDs, missing controls, or sub-44px mobile targets.
- Firefox passed desktop and mobile rendering at 1280×800 and 390×844.
- axe-core found zero WCAG 2.2 AA violations at 1440px, 390px, and 320px, including the open confirmation dialog.
- Reduced-motion, keyboard focus, skip navigation, native dialog semantics, touch controls, and mobile safe reflow were exercised.
- The direct LAN deployment and public TLS hostname each passed 33 authenticated browser assertions across desktop, mobile, and narrow-mobile viewports with zero unexpected browser errors.
- The backup panel retains the console's dark glass, acid-green, orange-warning visual system at every tested width; a simulated backup-storage failure left core recovery status online and clearly identified only the snapshot subsystem as unavailable.

## Production and host controls

- `claudia-recovery.service` is enabled and active at `127.0.0.1:4318` with zero restarts after the final deployment.
- The running code and browser assets match the audited source; the runtime copy is under `~/.local/lib/claudia-recovery`, outside the vault.
- The credential is systemd-encrypted outside Git; its directory is mode `0700` and encrypted file is mode `0600`.
- The local audit directory is mode `0700`; action entries contain only timestamp, fixed action name, and outcome.
- systemd unit verification passed. The service uses strict filesystem protection, read-only home access, private temporary storage, private keyring, hidden process access, namespace/SUID/realtime restrictions, no-new-privileges, native syscall architecture, and a narrow IP allowlist.
- The real authenticated action path restarted `claudia-dashboard.service` successfully while the independent recovery service remained active.
- The real password-rotation path atomically replaced the encrypted credential, restarted the recovery service, rejected the old password with `401`, accepted the new password with `200`, and preserved mode `0600` on the credential.
- The real production backup path created and re-verified `claudia-20260831T085046Z-dd635599`: a 248,365-byte local snapshot with matching SHA-256 metadata. The backup directory is mode `0700`; its archive and manifest are mode `0600`.
- Backup storage remains outside the canonical vault at `/var/lib/claudia-recovery/backups`. The portal intentionally exposes verification but no restore, deletion, arbitrary destination, or archive download operation.
- All five monitored services—gateway, dashboard, speech recognition, speech synthesis, and recovery—reported active after the action.

`systemd-analyze security` reports a 6.5 medium exposure score because this is a user-manager service that must read selected home paths, write its private snapshot store, accept Nginx Proxy Manager traffic, invoke the user service manager, and run V8. Several stronger capability and executable-memory restrictions are unavailable in this container or incompatible with Node. The portal compensates with application authentication, fixed action and backup operations, no shell, exact-origin enforcement, encrypted credentials, network allowlisting, private filesystem modes, and no privileged system service.

## Repository-wide release gate

- `git diff --check` passed.
- Gitleaks found no secrets in the complete private working tree or all reachable private history.
- The accompanying dashboard and local voice changes passed 26/26 unit/API/security tests, 19/19 authenticated HTTPS Chromium checks, 3/3 Firefox checks, 5/5 WCAG suites, and dependency auditing with zero vulnerabilities.
