# Claudia Recovery Audit

Audit date: 2026-08-30 (America/Chicago)

## Result

The independent recovery portal passed its release gates. It is enabled, authenticated, bound only to the intended LAN interface, and running from a deployment copy outside the canonical vault.

## Application and API

- 12/12 Node unit, API, and security tests passed.
- Anonymous access is limited to the minimal `/healthz` response; pages, status, diagnostics, and actions return `401` without the independent recovery credential.
- Authentication failures are throttled and return `429` after the configured limit.
- State changes require an exact trusted origin, a bounded JSON body, and one hardcoded action name.
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
- The authenticated production deployment passed 15 browser assertions across desktop, mobile, and narrow-mobile viewports with zero unexpected browser errors.

## Production and host controls

- `claudia-recovery.service` is enabled and active at `127.0.0.1:4318` with zero restarts after the final deployment.
- The running code and browser assets match the audited source; the runtime copy is under `~/.local/lib/claudia-recovery`, outside the vault.
- The credential is systemd-encrypted outside Git; its directory is mode `0700` and encrypted file is mode `0600`.
- The local audit directory is mode `0700`; action entries contain only timestamp, fixed action name, and outcome.
- systemd unit verification passed. The service uses strict filesystem protection, read-only home access, private temporary storage, private keyring, hidden process access, namespace/SUID/realtime restrictions, no-new-privileges, native syscall architecture, and a narrow IP allowlist.
- The real authenticated action path restarted `claudia-dashboard.service` successfully while the independent recovery service remained active.
- All five monitored services—gateway, dashboard, speech recognition, speech synthesis, and recovery—reported active after the action.

`systemd-analyze security` reports a medium exposure score because this is a user-manager service that must read selected home paths, accept Nginx Proxy Manager traffic, invoke the user service manager, and run V8. Several stronger capability and executable-memory restrictions are unavailable in this container or incompatible with Node. The portal compensates with application authentication, a fixed action allowlist, no shell, exact-origin enforcement, encrypted credentials, network allowlisting, and no privileged system service.

## Repository-wide release gate

- `git diff --check` passed.
- Gitleaks found no secrets in the complete private working tree or all reachable private history.
- The accompanying dashboard and local voice changes passed 26/26 unit/API/security tests, 19/19 authenticated HTTPS Chromium checks, 3/3 Firefox checks, 5/5 WCAG suites, and dependency auditing with zero vulnerabilities.
