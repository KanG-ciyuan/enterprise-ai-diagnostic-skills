# Security policy and boundary notes

**This is a local validation prototype, not a production service or a security-certified product.**

## Supported use

- Local exploration with synthetic data.
- Development and review by people who understand the prototype boundaries.
- Automated tests using the local model stub and isolated D1.

## Out of scope / not supported

- Production deployment, multi-tenant use, real customer onboarding.
- Real employee interviews, real customer records, credentials or confidential material.
- Internet-facing use of the development auth configuration.
- Any claim of security certification, penetration-test completion or compliance.

## Secret handling

- `.dev.vars` and other local secret files are excluded from this repository and from the staged release tree.
- The local `.dev.vars` file may contain a real model API key; it must be treated as a secret and never committed. Rotate it if it was ever shared or exposed.
- Test fixtures contain intentionally fake placeholder keys (for example values beginning with `sk-FAKE...` or `dummy-...`); they are not working credentials.
- This release tree contains **no real Cloudflare account IDs, D1 database IDs, queue identifiers or production domains**. The archive's `wrangler.toml.example` is a local-only template with placeholder values.

## Reporting a vulnerability

Report suspected vulnerabilities privately to the repository maintainer through GitHub Security Advisories (recommended) or the maintainer's published contact channel. Do **not** include real credentials, real enterprise data or raw interview records in a report. This prototype does not offer a bug-bounty program or a response-time guarantee.

## Boundary notes

- Model output is untrusted input. The server applies evidence, dependency and submission gates, but the semantic completeness of a model inference's dependency set cannot be proven by the server.
- Conservative dependency handling may over-invalidate inferences; this is a deliberate safety trade-off, not a production SLA.
- Authentication in the sample configuration uses development/demo paths. Do not expose that configuration to the internet.
