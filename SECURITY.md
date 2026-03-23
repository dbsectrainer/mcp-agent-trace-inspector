# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| latest  | Yes       |

We support the latest published version of `mcp-agent-trace-inspector` on npm. Update to the latest release before reporting a vulnerability.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Please report security issues by emailing the maintainers directly or using GitHub's private vulnerability reporting feature (Security → Report a vulnerability).

Include as much of the following as possible:

- A description of the vulnerability and its potential impact.
- Steps to reproduce the issue.
- Any proof-of-concept code, if applicable.
- The version of `mcp-agent-trace-inspector` you are using.

You can expect an initial response within **72 hours** and a resolution or status update within **14 days**.

## Security Considerations

`mcp-agent-trace-inspector` stores tool call inputs and outputs in a local SQLite database. Traces may contain sensitive data passed to or returned from your tools:

- Review trace contents before sharing or exporting dashboard files.
- Restrict file-system permissions on the database file (`~/.mcp/traces.db` by default).
- Use `--retention-days` to automatically purge old traces.
- Traces are never transmitted externally by this package.
