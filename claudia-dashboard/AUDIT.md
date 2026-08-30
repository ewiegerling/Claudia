# Claudia Dashboard audit baseline

The private production deployment passed its API/security, voice-boundary, real OpenClaw bridge, Chromium, Firefox, responsive-layout, WCAG 2.2 AA, dependency, service, and Lighthouse gates before this sanitized public edition was generated.

The public mirror must independently pass:

- Public-safety path, credential, SSH-material, home-path, private-address, and blocklist checks.
- Gitleaks scanning over the exported tree and complete public Git history.
- The Node API/security test suite.
- Strict PCM/WAV boundaries, same-origin voice intent, rate and concurrency limits, local speech-engine health, interruption, and typed-fallback coverage.
- Chromium desktop/mobile, Firefox desktop/mobile, and zero-violation axe checks across every page, including Voice Terminal.
- JSON and JavaScript syntax validation.

Deployment-specific hostnames, addresses, filesystem paths, proxy rules, certificates, authentication policies, and personal memory are intentionally omitted.

The speech runtime and model install outside Git and are checksum-pinned. The public mirror contains installer code and third-party notices, never model binaries, microphone recordings, agent transcripts, credentials, or private sessions.
