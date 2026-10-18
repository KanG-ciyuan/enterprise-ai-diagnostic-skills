# Enterprise AI-Assisted Interview & Diagnostic Prototype

**This directory is the application prototype inside the [enterprise-ai-diagnostic-skills](../../README.md) repository.**

**Status: local validation prototype · not production-ready · no real-customer validation**

A local proof-of-concept for **AI-assisted employee interviews and evidence-backed workflow diagnosis**. A user-initiated interview is guided by an AI assistant around one concrete piece of work. The assistant proposes questions and drafts; the employee answers, confirms or corrects the record; only then does the confirmed record become input to a diagnosis for human review.

The guiding rule is: **look at the evidence before drawing a conclusion.** The model can propose questions and draft inferences; the server decides what counts as established evidence.

> This is not a survey tool, not a commercial SaaS product, not a system that automatically transforms a company, and not a product validated with real merchants or production enterprise data.

---

## Why this exists

Enterprise AI projects often start by asking "which tool should we buy?" before anyone has established how the work actually happens. This prototype explores the opposite order:

1. interview the person who does the work;
2. capture what they actually do, including exceptions and hand-offs;
3. preserve evidence and its history;
4. let a second role verify high-impact facts;
5. only then discuss risks, options and a small shadow pilot.

The project is intentionally a **local prototype**. It exists to validate the interaction model, evidence model and safety boundaries — not to claim a finished commercial product.

---

## What is implemented

### AI-assisted interview

- A structured, question-by-question interview across seven dimensions:
  `trigger`, `inputs`, `steps`, `judgments`, `exceptions`, `handoff`, `burden`.
- The employee's statements are recorded as server-maintained statement history, not just a chat transcript.
- The interview is **not autonomous**: the user starts it, the employee answers and confirms the record, and the model cannot mark an inference as confirmed.
- The model can propose follow-up questions and candidate inferences; it cannot decide what counts as true.
- A local deterministic model stub is used by the test harness, so automated tests do not require paid model calls.

### Evidence and confirmation

- Server-side evidence snapshots with per-dimension digests (`answersDigest`, dimension digests, evidence sequence).
- Candidate inferences carry `evidenceRefs`, `evidenceVersion`, template/content versions and an evidence hash.
- Cross-dimension dependency rules (G14): when evidence a model inference depends on changes, the affected inference is invalidated; unrelated inferences remain unaffected.
- Dependency changes are append-only and auditable; invalidated verdicts become stale and cannot be submitted without re-confirmation.
- Submission is gated by server-side checks: evidence consistency, canonical workflow card, verdict freshness, dependency completeness and submission-state guards.
- Historical audit data is append-only with explicit capacity limits; capacity is fail-closed, not silently truncated.

### Roles and workflow

The formal flow supports four perspectives:

| Role | Main job |
|---|---|
| External builder / operator | Set up the project, record the enterprise authorization, invite members and manage the diagnosis process |
| Employee | Describe one actual piece of work and confirm/correct the evidence record |
| Verifier | Review evidence and confirm candidate facts; high-impact facts require a second independent confirmation |
| Enterprise owner | Review confirmed facts, risks and a small shadow-pilot recommendation; make the final decision |

Implemented workflow areas include project creation, enterprise authorization records, invitations, material metadata registration/review, the employee interview, verifier fact review, decision-packet drafting/verification and owner decisions. The local D1 database persists these records.

### Local demo

- A demo entry point provides four demo identities and seeded synthetic data so the flow can be inspected locally.
- All demo content is synthetic. The project does not ship real employee interviews, real material contents or a production database.

---

## Architecture

```text
Browser (vanilla ES modules)
  index.html / app.js / api-client.js / styles.css
        |
        | same-origin fetch
        v
Cloudflare Pages Functions  (functions/api/**)
  auth / projects / invitations / materials / work-items
  agent interview (employee-turn)
  evidence & verdict gates (employee-draft, employee-submission)
  verifier facts / decision packets / owner decisions
        |
        +--> D1 (SQLite; drafts, evidence, facts, decisions, audit)
        |
        +--> optional Queue consumers in workers/ (authorization confirmation)
        |
        +--> model adapter (DeepSeek-compatible HTTP API)
             or local stub in automated tests
```

Key directories:

| Path | Purpose |
|---|---|
| `index.html`, `app.js`, `styles.css` | Static prototype UI |
| `api-client.js` | Same-origin API client and session handling |
| `functions/` | Pages Functions API, evidence engine and submission gates |
| `schema.sql`, `migrations/` | D1 schema and forward migrations |
| `workers/` | Optional Cloudflare Queue consumers |
| `tests/` | Runtime and contract tests, including the G14 acceptance suites |
| `scripts/` | Local dev, static build and walkthrough scripts |
| `wrangler.toml.example`, `.dev.vars.example` | Local configuration templates (no real credentials or production IDs) |

---

## Local quick start

### Prerequisites

- Node.js 22+ (tested with Node 22.22.3)
- Python 3.11+ (for the optional walkthrough and Python contract tests)
- Cloudflare Wrangler 4.x (`npm install -g wrangler@4.127.1`, or an equivalent local install)
- No application `package.json` is required in this prototype.

### Run the app

```bash
cd apps/enterprise-diagnostic
cp .dev.vars.example .dev.vars      # add your own model credentials if you want live AI turns
cp wrangler.toml.example wrangler.toml
./scripts/dev.sh
```

Open `http://127.0.0.1:8788/`. Health check: `http://127.0.0.1:8788/api/health`.

Local runtime data is written under `.wrangler/state/` and is gitignored. Delete that directory to reset the local environment.

> The example configuration uses `development` auth mode and a local only test bootstrap path. **Do not use this configuration for a public deployment.** Live agent interviews require a model endpoint and credentials; the UI and demo paths can be inspected without a production model account, while automated tests use a local stub.

### Optional walkthrough

With the local server running:

```bash
python3 scripts/walkthrough.py
```

The walkthrough exercises the formal local loop through synthetic records. Exit code 0 means every step passed.

### Run targeted tests

```bash
node tests/pilot09c_g14_final_fix_runtime.mjs   # FINAL-F01/F02 focused, no DB needed
node tests/pilot09c_g14_runtime.mjs             # G14 cross-dimension behavior
```

The full `tests/` directory contains additional runtime and contract suites. The release candidate's G14 acceptance ran **231/231 targeted runtime checks** and **4/4 original G14 HTTP scenarios** on the frozen candidate; the final acceptance also independently re-ran the two new edge scenarios (3/3). This is a **targeted acceptance record**, not a claim that every test in the repository is green or that the product has passed a production security review. See `ACCEPTANCE.md` for scope and limits.

---

## What this prototype is not

- Not a generic AI questionnaire or survey tool.
- Not a commercially launched SaaS platform.
- Not validated with real merchants, real enterprise deployments or production data.
- Not an autonomous interviewer: the AI assists with questions and drafts, while the employee and authorized humans remain responsible for the facts and decisions.
- Not a system that can automatically transform a company or replace accountable human decisions.
- Not a production security certification. The repository intentionally excludes production deployment configurations and real credentials.
- Not an exhaustive diagnostic model: it covers one work item and seven evidence dimensions at a time.

## Known limitations

- Material handling is metadata registration/review in the prototype; real file upload and content analysis are not included.
- No OA/CRM/ERP integration and no real email/notification delivery in local development.
- Authentication is a local/demo model; there is no self-service registration and no production identity provider.
- The service cannot prove the semantic completeness of a model inference's dependency set; it uses explicit rules plus conservative over-invalidation when the model does not provide trustworthy dependencies.
- Conservative dependency handling can require more re-confirmation than a production product might accept.
- Cross-tab, multi-user and load behavior have not been validated at production scale.
- Some historical contract tests are known to be failing; they are not part of the G14 acceptance gate and are disclosed rather than hidden.

## Roadmap (not commitments)

- Design-partner pilots with synthetic or explicitly authorized data.
- Better model evaluation and interview quality measurement.
- Evidence export/import and an auditable project archive.
- Stronger role/session hardening and deployment recipes for controlled environments.
- Optional integrations (materials, notifications) behind explicit authorization and evidence controls.

## Security and data handling

This repository is a **local prototype**. Do not enter real employee names, customer records, credentials or confidential material into the demo. The repository excludes local secrets, runtime databases and production deployment identifiers. See `SECURITY.md` for reporting and boundary notes.

## License

This application directory is licensed under the **Apache License 2.0** (see `LICENSE` in this directory). Copyright 2026 Kang Jiaxin.

The rest of the repository (Skills, documents, simulations, etc.) is released under the repository-root **MIT License** (Copyright (c) Kang), unless a directory states otherwise. The root `LICENSE` does not override this directory's Apache-2.0 license. This directory bundles no third-party code or assets, so no separate NOTICE is required; if third-party material is added later, re-review and add notices.
## Contributing

This is a small prototype, not a community-governed project. Feedback and issue reports are welcome; please do not include real enterprise data or secrets in reports.

## Acknowledgements

The prototype was developed iteratively with local-only model stubs, evidence and security gate tests, and independent Codex/DSH review cycles. The repository does not claim third-party certification or production validation.
