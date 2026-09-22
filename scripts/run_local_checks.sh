#!/usr/bin/env bash
# Single local check runner for this repository.
#
# Runs the eight stdlib `unittest` suites plus the provenance guard, using the
# same commands documented in README.md under "Validation Status". CI calls this
# script so that local and CI execution cannot drift apart.
#
# Python 3 standard library only. No installation step, no pytest.
#
# Usage:  ./scripts/run_local_checks.sh
# Exit:   0 when every suite and the guard pass, 1 otherwise.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

SUITES=(
  "enterprise-interview-preparation/tests"
  "enterprise-workflow-mapping/tests"
  "enterprise-material-analysis/tests"
  "enterprise-ai-process-diagnosis/tests"
  "enterprise-ai-diagnostic-orchestrator/tests"
  "enterprise-ai-diagnostic-master-record/tests"
  "simulations/business-operations-crm-authorization/tests"
  "deliverables/management-diagnostic-report-v0.1/tests"
)

failed=0
total=0

echo "== Local check suites =="
for suite in "${SUITES[@]}"; do
  output="$(python3 -m unittest discover -s "$suite" 2>&1)"
  status=$?
  count="$(printf '%s\n' "$output" | sed -n 's/^Ran \([0-9][0-9]*\) test.*/\1/p' | tail -1)"
  count="${count:-0}"
  total=$((total + count))
  if [ "$status" -eq 0 ]; then
    printf '  %-62s OK   (%s tests)\n' "$suite" "$count"
  else
    printf '  %-62s FAIL (%s tests)\n' "$suite" "$count"
    printf '%s\n' "$output" | sed 's/^/      /'
    failed=1
  fi
done

echo
echo "== Provenance guard =="
if guard_output="$(python3 scripts/validate_personal_skill_ownership.py 2>&1)"; then
  printf '  %-62s OK   (%s)\n' "scripts/validate_personal_skill_ownership.py" "$guard_output"
else
  printf '  %-62s FAIL\n' "scripts/validate_personal_skill_ownership.py"
  printf '%s\n' "$guard_output" | sed 's/^/      /'
  failed=1
fi

echo
if [ "$failed" -eq 0 ]; then
  echo "All local checks passed. Suites: ${#SUITES[@]}, tests: ${total}."
else
  echo "Local checks FAILED. Suites: ${#SUITES[@]}, tests: ${total}."
fi
exit "$failed"
