"""Stop-state guards preserve the router's explicitly supported compact input."""
import copy
import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('r2_router', ROOT / 'scripts/orchestrate_event.py')
router = importlib.util.module_from_spec(spec); spec.loader.exec_module(router)


class R2StopTest(unittest.TestCase):
    def setUp(self):
        self.master = {'enterprise_id': 'ENT-SIM-RTL', 'project_id': 'PRJ-SIM-RTL-V02',
                       'current_stage': {'stage': 'workflow_mapping', 'status': 'active'}}
        self.event = json.loads((ROOT / 'examples/events/file-uploaded.json').read_text())

    def test_IR05_unreadable_stop_matrix_pauses(self):
        for stop in ({}, {'reason': 'Synthetic'}, {'status': 'ACTIVE'}, {'status': None},
                     {'status': 7}, {'status': []}, {'status': False}):
            with self.subTest(stop=stop):
                self.master['stops_and_recoveries'] = [stop]
                result = router.route_event(self.master, self.event)
                self.assertEqual('pause', result['decision'])
                self.assertFalse(result['proposed_state_change']['automatic_write'])

    def test_IR05_valid_stop_states_and_compact_input_still_work(self):
        self.assertEqual('invoke_skill', router.route_event(self.master, self.event)['decision'])
        for stops in ([], [{'status': 'recovered'}]):
            self.master['stops_and_recoveries'] = stops
            self.assertEqual('invoke_skill', router.route_event(self.master, self.event)['decision'])
        self.master['stops_and_recoveries'] = [{'status': 'active'}]
        self.assertEqual('pause', router.route_event(self.master, self.event)['decision'])
        self.master.pop('stops_and_recoveries')
        self.master['current_stage'].pop('status')
        self.assertEqual('invoke_skill', router.route_event(self.master, self.event)['decision'])

    def test_IR05_owner_recovery_constraints_are_preserved(self):
        self.master['current_stage'].update(stage='paused', status='paused')
        event = copy.deepcopy(self.event)
        event.update(event_type='manual_recovery_confirmed', actor_role='enterprise_project_owner',
                     payload={'resume_stage': 'evidence_completion', 'recovery_basis': 'Synthetic owner basis',
                              'recovery_conditions_met': True})
        self.assertIn('MANUAL_RECOVERY_CONFIRMED', router.route_event(self.master, event)['reason_codes'])
        event['actor_role'] = 'employee'
        self.assertNotIn('MANUAL_RECOVERY_CONFIRMED', router.route_event(self.master, event)['reason_codes'])
