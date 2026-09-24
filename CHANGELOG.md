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

## [0.1.1] — 2026-09-23

Snapshot taken after the first **green** CI run. `v0.1.0` was tagged while CI was
still failing on every push (see Fixed below), so this tag exists to mark a
revision whose stated checks were observed to pass on the runner, not only
locally.

### Fixed

- **A test imported a third-party package, so the suite was never actually
  standard-library-only.** `enterprise-interview-preparation/tests/test_package.py`
  did `import yaml`. PyYAML is not part of the standard library. The suite passed
  on any machine that happened to have PyYAML installed and failed on a clean one,
  which is why **every CI run failed from the first push onward while local runs
  stayed green** — including the `v0.1.0` tag and the run this entry was written
  to fix. CI output:

  ```
  FAIL (1 tests)
  ImportError: Failed to import test module: test_package
  ModuleNotFoundError: No module named 'yaml'
  ```

  The `yaml` call parsed the handoff block embedded in each
  `reports/runtime-case-*.md`. It is now replaced with standard-library
  structural checks, which is the change that keeps this repository's stated
  "Python 3 standard library only; there is nothing to install for validation"
  property true rather than adding a dependency to CI.

  **What the assertion still verifies:** exactly one handoff block per document;
  every contract key present as a top-level key; the `record_type` and
  `schema_version` literals; and that `participant_roles`, `evidence_requests`
  and `conflict_hypotheses` are block sequences whose items carry nested keys of
  their own.

  **What it no longer verifies:** full YAML semantics. The replacement does not
  implement flow collections, anchors, multi-line scalars, or type coercion, and
  it asserts literal text rather than parsed scalar types. A malformed YAML
  document that still has the right shape would now pass. This is a genuine
  reduction in strength, accepted in exchange for the suite running on a bare
  interpreter.

- **Verification now reproduces the CI environment.** Absence of PyYAML is
  simulated locally before trusting a green run:

  ```bash
  mkdir -p /tmp/noyaml
  printf 'raise ImportError("yaml is not installed")\n' > /tmp/noyaml/yaml.py
  PYTHONPATH=/tmp/noyaml ./scripts/run_local_checks.sh   # 8 suites, 131 tests, OK
  ```

  Every Python import across the tree was then audited: the only remaining
  non-stdlib import is the in-repo `validate_skill_handoff` module.

### Changed

- **`enterprise-material-analysis` `0.1.0` → `0.1.1`.** Three clarifications to
  `references/evidence-model.md`, the canonical definition of the `E1`–`E5`
  levels. No level was added, removed, or renumbered.

  1. **A level comes from the source, not from confidence.** A person who asserts
     "the policy requires X" without producing the document is `E3`, not `E4`.
     Without the document there is no way to separate *the rule says this* from
     *this is how the person remembers the rule*, so a verbal rule claim must not
     acquire institutional standing through repetition. A rule claim that cannot
     be documented stays `E3` for the whole engagement.
  2. **Unwritten rules stay `E3`.** A practice a role is expected to follow, which
     no document states, rests on one account. It is now labelled explicitly, with
     the reason recorded: unwritten rules are the most fragile class in the model,
     because with no document to hand over they are the first thing lost when the
     person leaves the role and nothing in the record shows that something was lost.
  3. **Document provenance is recorded as an open gap.** The model has no mechanism
     to establish that an uploaded file *is* an institutional document. This is the
     document-side form of the rule that fluent model output is not evidence: a
     document that looks official is not thereby authoritative. The entry names the
     reusable primitive that could close it — the named-authorizer capability already
     implemented in `enterprise_authorizations` — and states that `E4` must not be
     presented as authoritative while provenance is unestablished.

### Added

- **`case-studies/`** — a new directory for records of the method being used on
  **real work**, as distinct from `simulations/`, which holds synthetic `E5` cases.
  Every page states its own evidence level, its disclosure limits, and what it can
  and cannot support.
- [`case-studies/real-process-retrospective.md`](case-studies/real-process-retrospective.md) —
  the first such record: a desensitized retrospective on a process the maintainer
  personally executed. It documents a scope error the method caught by itself, two
  fluent-but-wrong AI inferences that were caught only because they were labelled
  as inferences and checked, the three rules promoted into the evidence model, the
  insight deliberately withheld, and a method limit the original design missed
  (a retrospective by someone who has left the role cannot be corroborated, so it
  stays `E3` permanently).
- Both READMEs link the record and state plainly that it is `E3`, that no client
  engagement has taken place, and that it is method validation rather than an
  enterprise diagnosis.

### On the provenance of these changes

All three came out of **one real, non-published case** (a retrospect on a process
the maintainer personally executed; the case itself stays private and is not in
this repository).

The project's own meta-rule permits a single case to change core rules only when
the item is a safety, fact, or permission invariant, or when a failure has recurred
across two or more unrelated industries. These three were admitted on the first
ground: each concerns what an evidence level can claim given its source, which is
independent of industry, role, or process vocabulary.

Process-specific detail from that case — the systems involved, the fields used, the
escalation path — was deliberately **kept out** of the reference and stays in the
private case record.

One further observation from the same case was **also deliberately held back**: that
when stated policy and reported practice match and both are followed, the defect
sits in the design rather than in compliance. It is plausible but rests on a single
case, so per the same meta-rule it is not yet a core rule. It is recorded here so the
judgement is visible rather than silently applied or silently dropped.

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

[Unreleased]: https://github.com/KanG-ciyuan/enterprise-ai-diagnostic-skills/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/KanG-ciyuan/enterprise-ai-diagnostic-skills/releases/tag/v0.1.1
[0.1.0]: https://github.com/KanG-ciyuan/enterprise-ai-diagnostic-skills/releases/tag/v0.1.0
