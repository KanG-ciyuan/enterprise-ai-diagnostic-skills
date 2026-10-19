"""Current-file guarantees; these tests never manufacture a real identity registry."""
import copy
import importlib.util
import json
import sys
import unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

def module(name):
    sys.path.insert(0,str(ROOT/'scripts'))
    try:
        spec=importlib.util.spec_from_file_location('p18_'+name,ROOT/'scripts'/f'{name}.py')
        result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result);return result
    finally:sys.path.pop(0)

def master():
    value=json.loads((ROOT/'examples/retail-complaint-master-record-v0.2.json').read_text())
    for card in value['workflow_cards']:
        card.update(employee_confirmed=True,confirmed_at=card['created_at'])
    return value

def handoff():return json.loads((ROOT/'examples/skill-handoffs/workflow-mapping.json').read_text())

class Pilot18AMasterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.validator=module('validate_master_record')
    def errors(self,r):return self.validator.validate_master_record(r)
    def test_legal_current_archive_still_passes(self):self.assertEqual([],self.errors(master()))
    def test_V02_zero_count_cannot_hide_deleted_required_task(self):
        r=master();r['research_coverage'][0]['planned_participants']=0;r['participant_tasks']=r['participant_tasks'][1:]
        self.assertTrue(any(x.startswith('COVERAGE_P0_TASK_MISSING:') for x in self.errors(r)))
    def test_V02_empty_plan_and_tasks_do_not_pass_diagnosis(self):
        r=master();r['research_coverage']=[];r['participant_tasks']=[]
        self.assertIn('COVERAGE_PLAN_REQUIRED',self.errors(r))
    def test_V02_zero_is_still_valid_before_diagnosis(self):
        r=master();r['current_stage']['stage']='interview_preparation';r['research_coverage'][0]['planned_participants']=0;r['participant_tasks']=[]
        self.assertEqual([],self.errors(r))
    def test_V02_planned_count_requires_enough_distinct_tasks(self):
        r=master();r['research_coverage'][0]['planned_participants']=2
        self.assertTrue(any(x.startswith('COVERAGE_P0_TASK_COUNT:') for x in self.errors(r)))
    def test_V02_explicit_risk_acceptance_requires_owner(self):
        r=master();t=r['participant_tasks'][0];t['status']='participant_declined';t.pop('current_workflow_card')
        t['risk_acceptance']={'accepted_by_role':'enterprise_project_owner','alternative_evidence':'Synthetic bounded alternative','residual_risk':'Unobserved handoff','continue_reason':'Owner accepts bounded review','applicable_scope':'PROC-COMPLAINT'}
        self.assertEqual([],self.errors(r))
        r['research_coverage'][0]['planned_participants']=0
        self.assertEqual([],self.errors(r))
        t['risk_acceptance']['accepted_by_role']='employee'
        self.assertIn('RISK_ACCEPTANCE_ROLE:TASK-CSR-001',self.errors(r))
    def test_V02_current_file_cannot_prove_no_historical_plan_was_deleted(self):
        r=master();r['research_coverage']=r['research_coverage'][:1];r['participant_tasks']=r['participant_tasks'][:1]
        # Remaining current-file coverage is coherent. Only a trusted prior plan can prove historical removal.
        self.assertEqual([],self.errors(r))
    def test_V02_owner_display_label_cannot_grant_employee_acceptance(self):
        r=master();r['project_identity']['project_owner_role']='employee'
        t=r['participant_tasks'][0];t['status']='participant_declined';t.pop('current_workflow_card')
        t['risk_acceptance']={'accepted_by_role':'employee','alternative_evidence':'Synthetic','residual_risk':'Unknown','continue_reason':'Synthetic','applicable_scope':'PROC-COMPLAINT'}
        self.assertIn('RISK_ACCEPTANCE_ROLE:TASK-CSR-001',self.errors(r))
    def test_V04_foreign_extra_task_fields_are_rejected(self):
        for field in ('enterprise_id','project_id'):
            r=master();r['participant_tasks'][0][field]='SYN-OTHER'
            self.assertTrue(any('SCHEMA_ADDITIONAL' in x and field in x for x in self.errors(r)))
    def test_V04_card_participant_and_process_must_match_task(self):
        for field in ('participant_id','process_id'):
            r=master();r['workflow_cards'][0][field]='SYN-OTHER'
            self.assertTrue(any(x.startswith('TASK_CARD_'+field.upper()+':') for x in self.errors(r)))
    def test_V04_card_scope_and_current_version_are_checked(self):
        for field,value in [('enterprise_id','ENT-OTHER'),('project_id','PRJ-OTHER'),('lifecycle_status','superseded'),('authorization_status','withdrawn')]:
            r=master();r['workflow_cards'][0][field]=value;self.assertTrue(self.errors(r),field)
        r=master();r['participant_tasks'][0]['current_workflow_card']='CARD-CSR-001@99';self.assertTrue(self.errors(r))
    def test_V02_risk_acceptance_is_not_accepted_from_an_employee_in_early_stages(self):
        r=master();r['current_stage']['stage']='evidence_completion'
        r['participant_tasks'][0]['risk_acceptance']={'accepted_by_role':'employee','alternative_evidence':'Synthetic','residual_risk':'Unknown','continue_reason':'Synthetic','applicable_scope':'PROC-COMPLAINT'}
        self.assertIn('RISK_ACCEPTANCE_ROLE:TASK-CSR-001',self.errors(r))
    def test_V04_duplicate_tasks_and_wrong_record_type_are_rejected(self):
        r=master();r['participant_tasks'].append(copy.deepcopy(r['participant_tasks'][0]));self.assertTrue(any(x.startswith('TASK_DUPLICATE_ID:') for x in self.errors(r)))
        r=master();r['participant_tasks'][0]['current_workflow_card']='MAT-SOP-001@1';self.assertTrue(any(x.startswith('TASK_CARD_NOT_WORKFLOW:') for x in self.errors(r)))
    def test_V05_all_index_required_fields_are_enforced(self):
        fields=json.loads((ROOT/'schema/master-record-v0.2.schema.json').read_text())['$defs']['indexedRecord']['required']
        for field in fields:
            with self.subTest(field=field):
                r=master();r['workflow_cards'][0].pop(field);self.assertTrue(any('SCHEMA_REQUIRED' in x and field in x for x in self.errors(r)))
    def test_V05_types_and_malformed_nested_shapes_fail_closed(self):
        for field,value in [('version',True),('version',0),('storage_ref',''),('record_type',''),('upstream_records',{})]:
            r=master();r['workflow_cards'][0][field]=value;self.assertTrue(self.errors(r),field)
        for field,value in [('current_stage',[]),('participant_tasks',[None]),('workflow_cards',[4]),('research_coverage',{}),('stops_and_recoveries',None)]:
            r=master();r[field]=value;self.assertTrue(self.errors(r),field)
    def test_H02_controller_completed_archive_requires_confirmation_basis(self):
        r=master();self.assertEqual([],self.errors(r))
        for field,value in [('employee_confirmed',False),('confirmed_at',None)]:
            r=master();r['workflow_cards'][0][field]=value
            self.assertIn('TASK_CARD_CONFIRMATION_MISSING:TASK-CSR-001',self.errors(r))

class Pilot18AHandoffTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.validator=module('validate_skill_handoff');cls.chain=module('validate_handoff_chain')
    def test_H02_unconfirmed_completed_rejected_at_both_entries(self):
        h=handoff();h['records_to_register'][0]['record']['employee_confirmed']=False;h['participant_task_updates'][0]['status']='completed'
        self.assertTrue(self.validator.validate_skill_handoff(h));self.assertTrue(self.chain.validate_handoff_chain(master(),[h]))
    def test_H02_even_confirmed_skill_cannot_self_complete(self):
        h=handoff();h['participant_task_updates'][0]['status']='completed'
        self.assertIn('TASK_STATUS_NOT_ALLOWED:enterprise-workflow-mapping/completed',self.validator.validate_skill_handoff(h))
    def test_H02_confirmed_requires_real_confirmation_fields(self):
        for field in ('employee_confirmed','confirmed_at'):
            h=handoff();h['records_to_register'][0]['record'].pop(field)
            self.assertTrue(any(x.startswith('WORKFLOW_CONFIRMATION_REQUIRED:') for x in self.validator.validate_skill_handoff(h)))
    def test_H02_legal_confirmed_and_controller_completion_are_distinct(self):
        h=handoff();self.assertEqual([],self.validator.validate_skill_handoff(h));self.assertEqual([],self.chain.validate_handoff_chain(master(),[h]))
        # Registered archive completion is a controller operation, not a fourth Skill producer.
        self.assertEqual([],module('validate_master_record').validate_master_record(master()))
    def test_H02_legal_employee_decline_remains_a_proposal(self):
        h=handoff();h['event_type']='workflow_card_declined';h['records_to_register']=[]
        h['participant_task_updates'][0].update(status='participant_declined',status_reason='Synthetic employee declined')
        h['participant_task_updates'][0].pop('current_workflow_card')
        self.assertEqual([],self.validator.validate_skill_handoff(h))
        self.assertEqual([],self.chain.validate_handoff_chain(master(),[h]))
    def test_H02_foreign_producer_and_task_updates_fail(self):
        h=handoff();h['producer_skill']='pretend-controller';self.assertTrue(self.validator.validate_skill_handoff(h))
        h=json.loads((ROOT/'examples/skill-handoffs/material-analysis.json').read_text());h['participant_task_updates']=handoff()['participant_task_updates']
        self.assertIn('PRODUCER_TASK_UPDATE_FORBIDDEN:enterprise-material-analysis',self.validator.validate_skill_handoff(h))
    def test_H02_version_and_scope_mismatches_fail_chain(self):
        for field,value in [('enterprise_id','ENT-OTHER'),('project_id','PRJ-OTHER')]:
            h=handoff();h['routing_context'][field]=value;self.assertTrue(self.chain.validate_handoff_chain(master(),[h]))
        h=handoff();h['participant_task_updates'][0]['current_workflow_card']='CARD-CSR-001@1'
        self.assertIn('WORKFLOW_CARD_TASK_MISMATCH',self.validator.validate_skill_handoff(h))
    def test_H02_handoff_card_and_task_identity_must_match(self):
        for field,value in [('participant_id','PART-OTHER'),('process_id','PROC-OTHER')]:
            h=handoff();h['routing_context'][field]=value;self.assertTrue(self.chain.validate_handoff_chain(master(),[h]))
    def test_H02_chain_does_not_accept_invalid_master_or_malformed_handoff(self):
        r=master();r['workflow_cards'][0].pop('storage_ref')
        self.assertTrue(self.chain.validate_handoff_chain(r,[handoff()]))
        for value in (None,[],{'producer_skill':[]}):self.assertTrue(self.validator.validate_skill_handoff(value))
