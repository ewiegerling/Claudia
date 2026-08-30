# Claudia Dashboard audit baseline

The private production deployment passed its API/security, Chromium, Firefox, responsive-layout, accessibility, dependency, and performance gates before this sanitized public edition was generated.

The public mirror must independently pass:

- Public-safety path, credential, SSH-material, home-path, private-address, and blocklist checks.
- Gitleaks scanning over the exported tree and complete public Git history.
- The Node API/security test suite.
- JSON and JavaScript syntax validation.

Deployment-specific hostnames, addresses, filesystem paths, proxy rules, certificates, authentication policies, and personal memory are intentionally omitted.
