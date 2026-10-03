# Security

The proxy binds to `127.0.0.1` by default. Credentials are redacted before
anything is written to disk, including `Authorization`, cookies containing
credentials, API keys, JWTs, private keys, and common cloud tokens. The raw
record is therefore a replayable sanitized protocol record rather than a byte
for byte secret-bearing capture.

Do not bind the proxy to a public interface unless an explicit network boundary
and authentication policy is in place. Historical tool calls in raw data are
data only; they are never executed by this project.
