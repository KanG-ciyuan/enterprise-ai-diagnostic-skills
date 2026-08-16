# External Task Package

Create a task only when the current Agent cannot safely continue without another person.

Required fields:

- `task_type`: `external_participation`, `H1`, `H2`, or `S0_recovery`;
- `responsible_role`: one role with authority or direct knowledge;
- `question`: one narrow question or action;
- `reason`: why the Agent cannot reliably finish it;
- `required_evidence`: minimum acceptable response or material;
- `affected_decision`: what remains blocked;
- `recovery_conditions`: explicit conditions for resuming;
- `expected_return_event`: the event name that re-enters the orchestrator.

Do not include restricted management context in an employee task. Do not ask the participant to select a Skill. Do not ask for a complete repeat interview when one missing fact can close the gap.

