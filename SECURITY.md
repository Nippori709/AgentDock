# Security Policy

LocalWorkspaceBridge connects an AI model to a real local workspace. Treat that capability as privileged developer access.

## Security boundaries

LocalWorkspaceBridge is designed to reduce accidental exposure and constrain normal tool use. It is **not** an operating-system sandbox and does not make untrusted repositories or commands safe by itself.

Key controls include:

- explicit allowed workspace roots;
- canonical-path and symlink checks;
- blocked sensitive paths such as `.env`, private keys, credential stores, dependency trees, and selected build/cache directories;
- secret redaction on tool output and secret-looking write protection;
- bounded reads, search results, analysis payloads, image sizes, and command output;
- separate `write` and `bash` policies;
- HTTP authentication for public/non-loopback serving;
- OAuth/PKCE support for stable public ChatGPT connections;
- query-string credentials disabled by default;
- safe Bash allowlisting/validation for common verification commands.

## Recommended configuration

For normal use:

```text
LOCALWORKSPACEBRIDGE_WRITE_MODE=workspace
LOCALWORKSPACEBRIDGE_BASH_MODE=safe
LOCALWORKSPACEBRIDGE_TOOL_MODE=standard
LOCALWORKSPACEBRIDGE_ALLOW_QUERY_TOKEN=0
```

Use `LOCALWORKSPACEBRIDGE_WRITE_MODE=off` for read-only sessions. Use `LOCALWORKSPACEBRIDGE_BASH_MODE=full` only for a repository and command environment you trust.

Do not expose a raw local port directly to the Internet. Prefer a supported HTTPS tunnel and keep authentication enabled.

## Secrets

Do not commit:

- HTTP tokens;
- tunnel credentials;
- private keys;
- `.env` files;
- saved local profile directories;
- screenshots or logs containing account information;
- machine-specific benchmark outputs containing local paths.

`config.example.env` contains placeholders only.

## Logs and telemetry

LocalWorkspaceBridge does not require hosted telemetry for its core functionality. Local diagnostic/benchmark output should avoid prompts, source bodies, credentials, and full command transcripts unless the user explicitly requests them.

## Reporting a vulnerability

If you publish a fork or hosted distribution, add a private security contact or GitHub Security Advisory channel before inviting external reports. Do not post working credentials or private workspace contents in a public issue.
