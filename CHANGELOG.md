# Changelog

All notable changes to this repository are recorded here.

This repository ships **skill packages**, not an installable library. Package
versions are independent of each other and of the repository tag. A repository
tag is therefore a **snapshot** of a consistent, fully-validated set of packages
— it is not a package version, and it does not override any package's own
declared `status` or `publication` field.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
at the repository level.

---

## [Unreleased]

Nothing yet.

---

## [0.1.0] — 2026-09-22

First tagged snapshot. Everything below is the state of the repository at this
tag; it is a **prototype**, and the caveats in `README.md` still apply in full.

### Packages in this snapshot

| Package | Version | Maturity tier | Declared status |
| --- | --- | --- | --- |
| `enterprise-interview-preparation` | `0.2.0` | `production-candidate` | `personal-experiment` / `local-only` |
| `enterprise-workflow-mapping` | `0.1.1` | `scaffold` | `personal-experiment` / `local-only` |
| `enterprise-material-analysis` | `0.1.0` | `production-candidate` | `personal-experiment` / `local-only` |
| `enterprise-ai-process-diagnosis` | `0.2.0` | `production-candidate` | `personal-experiment` / `local-only` |
| `enterprise-ai-diagnostic-orchestrator` | `0.1.0` | `production-candidate` | `personal-experiment` / `local-only` |
| `enterprise-ai-diagnostic-master-record` | schemas `v0.1` / `v0.2` | — (not a Skill) | — |

### Added

- **Continuous integration** (`.github/workflows/local-checks.yml`). Runs the
  eight validation suites plus the provenance guard on every push and pull
  request. Previously nothing validated this repository automatically.
- **Single local check runner** (`scripts/run_local_checks.sh`). Runs the same
  eight suites and the guard, prints a per-suite test count, and exits non-zero
  on any failure. CI calls this script, so local and CI execution cannot drift.
  Verified to fail: injecting one failing test produces exit code `1`.
- **System design specification**
  (`docs/superpowers/specs/2026-08-12-enterprise-ai-diagnosis-skill-system-design.md`).
  This document was already referenced by
  `simulations/manufacturing-emergency-procurement/07-external-ai-review-brief.md`,
  but the referenced path did not resolve in the published tree; the
  cross-reference now resolves.
- **This changelog.**

### Fixed

- **Shadow-pilot duration was stated inconsistently.**
  `simulations/business-operations-crm-authorization/33-process-b-simulated-diagnosis-gate-blocked.md`
  said `3-5天` while its own day-by-day table ran 第1天 through 第5天, the
  specification in `enterprise-ai-process-diagnosis/SKILL.md` and
  `references/diagnosis-framework.md` says `3-7 day`, and the concrete pilot
  artifacts are all 5-day runs. The document now reads `3-7天`, matching the
  specification, and its 5-day table remains consistent with that range.
- `README.md` previously stated that no `CHANGELOG`, no CI and no single root
  test runner existed. Those statements are updated to match this tag.

### Validation at this tag

```
./scripts/run_local_checks.sh
```

| Suite | Tests |
| --- | --- |
| `enterprise-interview-preparation/tests` | 9 |
| `enterprise-workflow-mapping/tests` | 7 |
| `enterprise-material-analysis/tests` | 7 |
| `enterprise-ai-process-diagnosis/tests` | 7 |
| `enterprise-ai-diagnostic-orchestrator/tests` | 23 |
| `enterprise-ai-diagnostic-master-record/tests` | 56 |
| `simulations/business-operations-crm-authorization/tests` | 17 |
| `deliverables/management-diagnostic-report-v0.1/tests` | 5 |
| **Total** | **131** |

Provenance guard: `personal_skill_ownership_valid`.

Python 3 standard library only; nothing is installed.

### Not claimed at this tag

Stated explicitly so this changelog cannot be read as more than it is:

- No real enterprise engagement, no client, no anonymized client. Every
  enterprise identifier in the tree carries a `SIM` or `SYN` marker.
- No ROI, efficiency, cost, quality or accuracy result has been measured.
- No shadow pilot has been executed. The only run record is a synthetic,
  accelerated, single-session simulation.
- No independent or provider-backed validation. The repository's own artifact
  records `"provider_backed": false`.
- Not production-ready, not cross-platform, and not a runtime system. Every
  package declares `status: personal-experiment` and `publication: local-only`,
  and `target_platforms: ["codex"]`.
- The tests validate the repository against itself. The large majority are
  string-containment assertions on Markdown; none tests a real model.

[Unreleased]: https://github.com/KanG-ciyuan/enterprise-ai-diagnostic-skills/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/KanG-ciyuan/enterprise-ai-diagnostic-skills/releases/tag/v0.1.0
