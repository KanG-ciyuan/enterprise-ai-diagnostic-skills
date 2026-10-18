# Acceptance record (limited scope)

This file records what was actually verified for the **G14 candidate** and what was **not** verified. It is intentionally narrow.

## Candidate identity

| Item | Value |
|---|---|
| Accepted worktree | `.worktrees/demo-mode-local` |
| Branch | `feat/v0.1-batch1-evidence-and-guardrails` |
| Candidate source fingerprint | 131 files / `7f34599d2c22193ce1bc24e5c746952c010b410811ca7ec5463ea75e11f691b4` |
| HEAD at acceptance | `e24ca61867a470736e2251fb73b5042d7f17c97a` (uncommitted worktree) |
| FREEZE blob | `d766aa67b2d1e335f738240135eb09ae3a6b0ce6` |
| Independent acceptance | `PILOT-09C-G14-FINAL-ACCEPTANCE-01` — `G14_FINAL_ACCEPTANCE = GO`, `G14_CLOSE_RECOMMENDATION = YES` |

The acceptance was **read-only** and used temporary copies, local Wrangler, isolated D1 and a local model stub. No paid model, production database or real enterprise data was used.

## Passed checks

| Check | Result |
|---|---|
| FINAL-F01: withdraw a dependent dimension, re-confirm, restore through employee-turn, do not re-confirm target, then submit | **PASS** — dependency restored, `evidenceVersion` advanced, old verdict stale, submission **422**, reject path zero writes, submission **200** after re-confirmation |
| FINAL-F02: same inference ID/text, explicit empty dependency suggestions after a prior suggestion, plus handoff change | **PASS** — old suggestion not inherited, server re-adjudicated, conservative seven-dimension scope, `evidenceVersion` advanced, old verdict stale, submission **422** until re-confirmation, then **200**; omitted ID preserved |
| Original G14-F01–F04 after the final fix | **PASS** — independent local HTTP run, 4/4 scenarios |
| G14 targeted runtime acceptance | **231/231** checks passed across the 11 targeted suites |
| FINAL-F01/FINAL-F02 targeted runtime checks | **21/21** passed |
| New FINAL edge HTTP scenarios | **3/3** passed on the final source |
| Local model stub, isolated D1, real HTTP | Used for the above scenarios; no dependency fields were pre-seeded for the new edge cases |

## Not verified

- Not a full-suite claim: the repository includes additional suites, browser tests and Python contract tests that were **not all re-run** for this release preparation. Historical Python contract failures were previously disclosed and are not fixed here.
- No real-model quality evaluation.
- No production deployment, load, multi-tenant, or security certification.
- No real customer, merchant or enterprise data validation.
- No claim that every test in this repository is currently green.

## Evidence retention notes (P3)

The original acceptance evidence package is retained outside this repository. It is **not** copied into the public release tree because it includes raw D1 snapshots, HTTP logs and internal review history. If the maintainer later publishes evidence, the following bookkeeping issues should be cleaned first (they do not change the acceptance result):

1. `final-source-manifest.json` and `green-source-manifest.json` in the evidence package are intermediate snapshots and do not match the final 131-file source; `verified-source-manifest.json` / `final-state.json` are authoritative.
2. `source-delta.json` has `ok:false` as an expected-change artifact; label it as such.
3. The archived `http-review.mjs` imports a temporary absolute path; use a relative `./lib.mjs` when re-running.
4. The staged release copy trims two historical whitespace-only blank lines (`app.js`, `tests/pilot04c_runtime.mjs`); the original worktree and evidence are untouched. The acceptance result was not affected.

## Security boundary

The acceptance covers the specified G14 dependency and submission gates only. It does not certify the broader application, authentication model, deployment configuration or data-handling practices. See `SECURITY.md`.
