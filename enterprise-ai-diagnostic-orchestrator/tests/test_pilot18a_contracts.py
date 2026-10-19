"""Behavioral regressions for PILOT-18A; synthetic data and local files only."""
import copy
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
MARKER = 'SYNTHETIC-RESTRICTED-NOTE-PILOT18A'

def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

class Pilot18ARouterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.router = module(ROOT/'scripts/orchestrate_event.py', 'pilot18a_router')
        cls.runner = module(ROOT/'scripts/run_offline_simulation.py', 'pilot18a_offline')

    def setUp(self):
        self.master = json.loads((REPO/'enterprise-ai-diagnostic-master-record/examples/retail-complaint-master-record-v0.2.json').read_text())
        self.event = json.loads((ROOT/'examples/events/file-uploaded.json').read_text())
        self.before = copy.deepcopy(self.master)

    def route(self, **changes):
        event = copy.deepcopy(self.event)
        event.update(changes)
        return self.router.route_event(self.master, event)

    def test_R01_paused_ordinary_event_matrix(self):
        for stop in ('stage', 'status', 'active_stop'):
            for event_type in ('file_uploaded','participant_task_started','management_problem_submitted','diagnosis_gate_ready'):
                with self.subTest(stop=stop,event=event_type):
                    self.master = copy.deepcopy(self.before)
                    if stop == 'active_stop': self.master['stops_and_recoveries'][0]['status'] = 'active'
                    else: self.master['current_stage'][stop] = 'paused'
                    result = self.route(event_type=event_type, actor_role='enterprise_project_owner')
                    self.assertNotEqual('invoke_skill',result['decision'])
                    self.assertFalse(result['proposed_state_change'].get('automatic_write',False))

    def test_R01_manual_recovery_keeps_original_constraints(self):
        self.master['current_stage'].update(stage='paused',status='paused')
        payload = {'recovery_conditions_met':True,'recovery_basis':'Synthetic owner re-authorized the source','resume_stage':'evidence_completion'}
        good = self.route(event_type='manual_recovery_confirmed',actor_role='enterprise_project_owner',payload=payload)
        self.assertIn('MANUAL_RECOVERY_CONFIRMED',good['reason_codes'])
        self.assertEqual('evidence_completion',good['proposed_state_change']['suggested_stage'])
        for key,value in [('recovery_basis',''),('recovery_conditions_met',False),('resume_stage','diagnosis')]:
            bad = copy.deepcopy(payload);bad[key]=value
            result = self.route(event_type='manual_recovery_confirmed',actor_role='enterprise_project_owner',payload=bad)
            self.assertNotIn('MANUAL_RECOVERY_CONFIRMED',result['reason_codes'])
        result=self.route(event_type='manual_recovery_confirmed',actor_role='employee',payload=payload)
        self.assertNotIn('MANUAL_RECOVERY_CONFIRMED',result['reason_codes'])

    def test_R02_role_gate_and_stage_gate_are_independent(self):
        for role in ('employee','agent'):
            self.assertNotEqual('invoke_skill',self.route(event_type='diagnosis_gate_ready',actor_role=role)['decision'])
        self.assertEqual('invoke_skill',self.route(event_type='diagnosis_gate_ready',actor_role='enterprise_project_owner')['decision'])
        self.master['current_stage']['stage']='evidence_completion'
        result=self.route(event_type='diagnosis_gate_ready',actor_role='enterprise_project_owner')
        self.assertIn('DIAGNOSIS_GATE_NOT_CONFIRMED',result['reason_codes'])

    def test_R02_employee_cannot_confirm_scope_plan(self):
        result=self.route(event_type='interview_plan_confirmed',payload={'owner_confirmed':True},actor_role='employee')
        self.assertFalse(result['proposed_state_change'].get('research_coverage_proposals'))
        self.assertIn('EVENT_ROLE_FORBIDDEN',result['reason_codes'])

    def test_R03_unknown_empty_and_wrong_type_roles_are_rejected(self):
        for value in ('unknown','',None,4,False,[],{}):
            with self.subTest(value=value):
                self.assertNotEqual('invoke_skill',self.route(actor_role=value)['decision'])

    def test_R03_cli_executes_event_structure_validation(self):
        for mutation in ('missing_role','payload_list','wrong_contract','missing_source'):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as folder:
                e=copy.deepcopy(self.event)
                if mutation=='missing_role':e.pop('actor_role')
                if mutation=='payload_list':e['payload']=[]
                if mutation=='wrong_contract':e['contract_type']='wrong'
                if mutation=='missing_source':e.pop('source_status')
                m=Path(folder)/'master.json';p=Path(folder)/'event.json'
                m.write_text(json.dumps(self.master));p.write_text(json.dumps(e))
                run=subprocess.run([sys.executable,str(ROOT/'scripts/orchestrate_event.py'),str(m),str(p)],capture_output=True,text=True)
                self.assertEqual(0,run.returncode,run.stderr)
                self.assertEqual('pause',json.loads(run.stdout)['decision'])

    def test_R05_only_known_authorized_states_may_invoke(self):
        for status in ('authorized','restricted','not_required'):
            self.assertEqual('invoke_skill',self.route(authorization_status=status)['decision'])
        for status in ('pending','withdrawn','not-a-status','',None,7,[],{}):
            with self.subTest(status=status):
                self.assertNotEqual('invoke_skill',self.route(authorization_status=status)['decision'])

    def test_R04_employee_projection_is_allowlisted_and_recursive(self):
        payload={'task_id':'TASK-SYN-1','participant_id':'PART-SYN-1','process_id':'PROC-SYN-1','version':2,'source_records':['MAT-SYN-1@2'], 'employee_visible_context_only':True,'employee_visible_context':{'process_name':'Synthetic process','restricted_management_notes':MARKER},'restricted_management_notes':MARKER,'unknown':{'note':MARKER},'problem_statement':MARKER}
        result=self.route(event_type='participant_task_started',payload=payload)
        self.assertEqual('invoke_skill',result['decision'])
        context=result['context_package']
        self.assertEqual(self.master['enterprise_id'],context['enterprise_id'])
        self.assertEqual(2,context['payload']['version'])
        self.assertEqual(['MAT-SYN-1@2'],context['payload']['source_records'])
        self.assertEqual('Synthetic process',context['payload']['employee_visible_context']['process_name'])
        self.assertNotIn(MARKER,json.dumps(result))
        self.assertNotIn('unknown',context['payload'])

    def test_R04_restricted_marker_absent_from_cli_stdout(self):
        with tempfile.TemporaryDirectory() as folder:
            e=copy.deepcopy(self.event);e['payload']['restricted_management_notes']=MARKER
            m=Path(folder)/'master.json';p=Path(folder)/'event.json';m.write_text(json.dumps(self.master));p.write_text(json.dumps(e))
            run=subprocess.run([sys.executable,str(ROOT/'scripts/orchestrate_event.py'),str(m),str(p)],capture_output=True,text=True)
            self.assertEqual(0,run.returncode);self.assertNotIn(MARKER,run.stdout+run.stderr)
            self.assertEqual('invoke_skill',json.loads(run.stdout)['decision'])

    def test_R04_offline_outputs_and_local_logs_do_not_retain_payload_marker(self):
        source=REPO/'simulations/business-operations-crm-authorization/runtime-simulation'
        with tempfile.TemporaryDirectory() as folder:
            scenario=json.loads((source/'scenario.json').read_text())
            for event in scenario['events']:
                event['payload']['restricted_management_notes']=MARKER
                if 'human_task' in event['payload']:event['payload']['human_task']['restricted_management_notes']=MARKER
            path=Path(folder)/'scenario.json';path.write_text(json.dumps(scenario))
            output=Path(folder)/'result'
            result=self.runner.run_simulation(source/'master-record.json',path,output)
            self.assertEqual('evidence_completion',result['final_master_record']['current_stage']['stage'])
            self.assertNotIn(MARKER,json.dumps(result))
            for f in output.iterdir():self.assertNotIn(MARKER,f.read_text(),f.name)

    def test_legal_routes_and_inputs_still_work(self):
        for event_type,role in [('management_problem_submitted','enterprise_project_owner'),('participant_task_started','employee'),('file_uploaded','employee')]:
            self.assertEqual('invoke_skill',self.route(event_type=event_type,actor_role=role)['decision'])
        before=copy.deepcopy(self.event);self.route();self.assertEqual(before,self.event);self.assertEqual(self.before,self.master)
