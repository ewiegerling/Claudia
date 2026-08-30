# Security

Do not report security issues by committing credentials, private memory, host details, or exploit payloads to the repository.

This reference dashboard is read-only by design, but a real deployment can expose private Markdown and host telemetry. Keep the upstream on loopback or a tightly restricted private interface, terminate TLS at a trusted reverse proxy, and require authentication before remote access.

The public-export audit rejects common credentials, SSH key material, private network addresses, absolute user-home paths, private runtime directories, and operator-maintained blocked terms.
