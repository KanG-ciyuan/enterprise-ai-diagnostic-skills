"""R2 contract regressions using synthetic records, no model or network."""
import copy
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
try:
    from validate_skill_handoff import validate_skill_handoff
    from validate_handoff_chain import validate_handoff_chain
    from validate_master_record import validate_master_record, validate_authorization
    from diagnostic_contract_schema import validate_schema
finally:
    sys.path.pop(0)


def load(name):
    return json.loads((ROOT / 'examples' / name).read_text())


def master():
    return load('retail-complaint-master-record-v0.2.json')


def workflow():
    return load('skill-handoffs/workflow-mapping.json')


def pending(field):
    value = workflow()
    value.update(handoff_status='needs_registration_context', missing_registration_fields=[field])
    value['routing_context'][field] = None
    value['records_to_register'][0]['record'].pop(field, None)
    return value


def declined(with_card=True):
    value = workflow()
    value['event_type'] = 'workflow_card_declined'
    value['participant_task_updates'][0]['status'] = 'participant_declined'
    if with_card:
        record = value['records_to_register'][0]['record']
        record['employee_confirmed'] = False
        record.pop('confirmed_at')
    else:
        value['records_to_register'] = []
        value['participant_task_updates'][0].pop('current_workflow_card')
    return value


def material_handoff(record=None):
    value = load('skill-handoffs/material-analysis.json')
    value['records_to_register'] = value['records_to_register'][:1]
    value['unresolved_items'] = []
    if record is not None:
        value['records_to_register'][0]['record'] = record
    return value


def diagnosis_handoff():
    value = load('skill-handoffs/diagnosis.json')
    value['records_to_register'][0]['record'].update(
        upstream_records=['EVIDENCE-V02-001@1'], outstanding_gaps=['GAP-QA-001@1'])
    return value


def withdrawn_input():
    base = master()
    item = copy.deepcopy(base['materials'][0])
    item.update(record_id='MAT-SYN-WITHDRAWN', authorization_status='withdrawn', content_hash='c' * 64)
    base['materials'].append(item)
    return base


def candidate(base, handoff):
    value = copy.deepcopy(base)
    record = copy.deepcopy(handoff['records_to_register'][0]['record'])
    for old in value['workflow_cards']:
        if f"{old['record_id']}@{old['version']}" == record.get('supersedes'):
            old['lifecycle_status'] = 'superseded'
    value['workflow_cards'].append(record)
    value['participant_tasks'][0]['current_workflow_card'] = f"{record['record_id']}@{record['version']}"
    return value


class R2HandoffTest(unittest.TestCase):
    def test_IR01_declared_missing_participant_and_process_are_valid(self):
        for field in ('participant_id', 'process_id'):
            for explicit_null in (False, True):
                with self.subTest(field=field, explicit_null=explicit_null):
                    value = pending(field)
                    if explicit_null:
                        value['records_to_register'][0]['record'][field] = None
                    self.assertEqual([], validate_skill_handoff(value))

    def test_IR01_missing_identity_must_be_declared(self):
        for field in ('participant_id', 'process_id'):
            value = pending(field)
            value['missing_registration_fields'] = []
            self.assertTrue(validate_skill_handoff(value))

    def test_IR01_known_identity_still_must_match(self):
        for field in ('participant_id', 'project_id', 'enterprise_id'):
            value = pending('process_id')
            value['records_to_register'][0]['record'][field] = 'SYN-OTHER'
            self.assertTrue(validate_skill_handoff(value), field)

    def test_IR01_ready_must_have_identity_and_no_missing_declaration(self):
        self.assertEqual([], validate_skill_handoff(workflow()))
        for field in ('participant_id', 'process_id'):
            value = pending(field)
            value['handoff_status'] = 'ready_for_registration'
            self.assertTrue(validate_skill_handoff(value))
        value = workflow()
        value['missing_registration_fields'] = ['participant_id']
        self.assertTrue(validate_skill_handoff(value))

    def test_IR01_pending_does_not_become_a_registration_or_mutate_input(self):
        value = pending('participant_id')
        before = copy.deepcopy(value)
        self.assertEqual([], validate_skill_handoff(value))
        self.assertTrue(validate_handoff_chain(master(), [value]))
        self.assertEqual(before, value)
        self.assertEqual('needs_registration_context', value['handoff_status'])

    def test_IR01_unknown_task_is_not_fabricated_for_pending_card(self):
        value = workflow()
        value.update(handoff_status='needs_registration_context', missing_registration_fields=['task_id'])
        value['routing_context']['task_id'] = None
        value['participant_task_updates'] = []
        self.assertEqual([], validate_skill_handoff(value))
        self.assertTrue(validate_handoff_chain(master(), [value]))
        value.update(handoff_status='ready_for_registration', missing_registration_fields=[])
        self.assertTrue(validate_skill_handoff(value))

    def test_IR01_pending_does_not_relax_confirmation_producer_or_version(self):
        for field, bad in (('employee_confirmed', False), ('confirmed_at', None), ('version', True)):
            value = pending('participant_id')
            value['records_to_register'][0]['record'][field] = bad
            self.assertTrue(validate_skill_handoff(value), field)
        value = pending('participant_id')
        value['producer_skill'] = 'pretend-controller'
        self.assertTrue(validate_skill_handoff(value))

    def test_IR01_explicit_null_administrative_metadata_stays_pending(self):
        for field in ('enterprise_id', 'project_id', 'authorization_status', 'storage_ref', 'upstream_records'):
            value = workflow()
            value.update(handoff_status='needs_registration_context', missing_registration_fields=[field])
            value['records_to_register'][0]['record'][field] = None
            if field in value['routing_context']:
                value['routing_context'][field] = None
            self.assertEqual([], validate_skill_handoff(value), field)
            self.assertTrue(validate_handoff_chain(master(), [value]), field)

    def test_IR02_declined_without_card_remains_valid(self):
        value = declined(False)
        self.assertEqual([], validate_skill_handoff(value))
        self.assertEqual([], validate_handoff_chain(master(), [value]))

    def test_IR02_declined_own_draft_remains_valid(self):
        value = declined()
        self.assertEqual([], validate_skill_handoff(value))
        self.assertEqual([], validate_handoff_chain(master(), [value]))
        self.assertFalse(value['records_to_register'][0]['record']['employee_confirmed'])

    def test_IR02_declined_identity_scope_and_exact_version_must_match(self):
        for field in ('participant_id', 'process_id', 'project_id'):
            value = declined()
            value['records_to_register'][0]['record'][field] = 'SYN-OTHER'
            self.assertTrue(validate_skill_handoff(value), field)
            self.assertTrue(validate_handoff_chain(master(), [value]), field)
        value = declined()
        value['participant_task_updates'][0]['current_workflow_card'] = 'CARD-CSR-001@99'
        self.assertTrue(validate_skill_handoff(value))

    def test_IR02_declined_must_not_claim_confirmation(self):
        value = declined()
        value['records_to_register'][0]['record']['employee_confirmed'] = True
        self.assertTrue(validate_skill_handoff(value))

    def test_IR02_declined_existing_card_reference_still_checks_identity(self):
        value = declined(False)
        value['participant_task_updates'][0]['current_workflow_card'] = 'CARD-MGR-001@1'
        self.assertTrue(validate_handoff_chain(master(), [value]))

    def test_IR03_direct_withdrawal_agrees_with_candidate_master(self):
        base = withdrawn_input()
        self.assertEqual([], validate_master_record(base))
        value = workflow()
        value['records_to_register'][0]['record']['upstream_records'].append('MAT-SYN-WITHDRAWN@1')
        before = copy.deepcopy(value)
        expected = 'AUTH_WITHDRAWN_UPSTREAM:CARD-CSR-001@2->MAT-SYN-WITHDRAWN@1'
        self.assertIn(expected, validate_handoff_chain(base, [value]))
        self.assertIn(expected, validate_master_record(candidate(base, value)))
        self.assertEqual(before, value)

    def test_IR03_indirect_withdrawal_agrees_with_candidate_master(self):
        base = withdrawn_input()
        bridge = copy.deepcopy(base['materials'][0])
        bridge.update(record_id='MAT-SYN-BRIDGE', lifecycle_status='superseded',
                      content_hash='d' * 64, upstream_records=['MAT-SYN-WITHDRAWN@1'])
        base['materials'].append(bridge)
        self.assertEqual([], validate_master_record(base))
        value = workflow()
        value['records_to_register'][0]['record']['upstream_records'].append('MAT-SYN-BRIDGE@1')
        expected = 'AUTH_WITHDRAWN_ANCESTOR:CARD-CSR-001@2->MAT-SYN-WITHDRAWN@1'
        self.assertIn(expected, validate_handoff_chain(base, [value]))
        self.assertIn(expected, validate_master_record(candidate(base, value)))

    def test_IR03_indirect_withdrawal_through_prior_handoff(self):
        base = withdrawn_input()
        bridge = copy.deepcopy(base['materials'][0])
        bridge.update(record_id='MAT-SYN-BRIDGE', lifecycle_status='superseded',
                      content_hash='d' * 64, upstream_records=['MAT-SYN-WITHDRAWN@1'])
        value = workflow()
        value['records_to_register'][0]['record']['upstream_records'].append('MAT-SYN-BRIDGE@1')
        self.assertIn('AUTH_WITHDRAWN_ANCESTOR:CARD-CSR-001@2->MAT-SYN-WITHDRAWN@1',
                      validate_handoff_chain(base, [material_handoff(bridge), value]))

    def test_IR03_authorized_derivation_still_passes(self):
        value = workflow()
        value['records_to_register'][0]['record']['upstream_records'].append('MAT-TICKET-001@1')
        base = master()
        self.assertEqual([], validate_handoff_chain(base, [value]))
        self.assertEqual([], validate_authorization(candidate(base, value)))
        self.assertEqual([], validate_master_record(candidate(base, value)))

    def test_IR03_duplicate_reference_cannot_mask_withdrawn_record(self):
        base = withdrawn_input()
        value = workflow()
        value['records_to_register'][0]['record'].update(
            record_id='MAT-SYN-WITHDRAWN', version=1, supersedes=None)
        value['participant_task_updates'][0]['current_workflow_card'] = 'MAT-SYN-WITHDRAWN@1'
        self.assertTrue(validate_handoff_chain(base, [value]))

    def test_IR04_collection_required_fields_are_enforced(self):
        for value, field in ((material_handoff(), 'analysis_status'), (diagnosis_handoff(), 'review_status')):
            value['records_to_register'][0]['record'].pop(field)
            self.assertTrue(any('SCHEMA_REQUIRED:' in e and field in e for e in validate_skill_handoff(value)))

    def test_IR04_wrong_outstanding_gaps_types_rejected_at_both_entries(self):
        for bad in (None, {}, 'GAP-QA-001@1', 7):
            value = diagnosis_handoff()
            value['records_to_register'][0]['record']['outstanding_gaps'] = bad
            self.assertTrue(validate_skill_handoff(value))
            self.assertTrue(validate_handoff_chain(master(), [value]))

    def test_IR04_valid_materials_and_diagnoses_still_pass(self):
        for value in (material_handoff(), diagnosis_handoff()):
            self.assertEqual([], validate_skill_handoff(value))
            self.assertEqual([], validate_handoff_chain(master(), [value]))

    def test_IR04_bad_nested_type_cli_returns_errors_without_traceback(self):
        value = diagnosis_handoff()
        value['records_to_register'][0]['record']['outstanding_gaps'] = None
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder) / 'master.json'; handoff = Path(folder) / 'handoff.json'
            base.write_text(json.dumps(master())); handoff.write_text(json.dumps(value))
            run = subprocess.run([sys.executable, '-B', str(ROOT / 'scripts/validate_handoff_chain.py'),
                                  str(base), str(handoff)], capture_output=True, text=True)
            self.assertEqual(1, run.returncode)
            self.assertIn('SCHEMA_TYPE:', run.stdout)
            self.assertNotIn('Traceback', run.stdout + run.stderr)
            self.assertFalse(run.stderr)

    def test_IR04_diagnostic_only_extension_not_traversed_on_material(self):
        value = material_handoff()
        value['records_to_register'][0]['record']['outstanding_gaps'] = None
        self.assertEqual([], validate_handoff_chain(master(), [value]))

    def test_IR06_bad_refs_rejected_in_condition_and_unused_branches(self):
        for schema in (
            {'$ref': '#/$defs/absent'},
            {'if': {'$ref': '#/$defs/absent'}, 'then': {'required': ['owner_confirmed']}},
            {'properties': {'optional': {'$ref': '#/$defs/absent'}}},
            {'if': {'const': 9}, 'then': {'$ref': '#/$defs/absent'}},
        ):
            self.assertTrue(any(e.startswith('SCHEMA_REF_INVALID:') for e in validate_schema({}, schema)))

    def test_IR06_valid_reference_conditions_keep_true_and_false_semantics(self):
        schema = {'$defs': {'ready': {'properties': {'ready': {'const': True}}, 'required': ['ready']}},
                  'if': {'$ref': '#/$defs/ready'}, 'then': {'required': ['owner_confirmed']}}
        self.assertEqual([], validate_schema({'ready': False}, schema))
        self.assertEqual([], validate_schema({'ready': True, 'owner_confirmed': True}, schema))
        self.assertTrue(validate_schema({'ready': True}, schema))

    def test_IR06_bad_ref_target_or_value_reports_schema_error(self):
        for schema in ({'$ref': None}, {'$ref': '#/$defs/not_schema', '$defs': {'not_schema': 5}}):
            self.assertTrue(validate_schema({}, schema))
