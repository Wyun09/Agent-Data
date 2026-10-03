# Contributing

Keep provider-specific behavior inside its protocol or integration package.
Changes to an SSE parser or normalizer must include a sanitized fixture and a
regression test. Raw event order must be preserved and recording failures must
not make an upstream response fail when forwarding can continue.

Run:

```bash
npm install
npm test
npm run lint
```
