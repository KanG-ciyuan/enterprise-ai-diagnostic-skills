"""Validate observable contract edge cases of the bounded stdlib vocabulary."""
import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
try:
    from diagnostic_contract_schema import validate_schema
finally:sys.path.pop(0)

class ContractSchemaTest(unittest.TestCase):
    def test_required_nested_properties_and_no_extra_fields(self):
        s={'type':'object','required':['task'],'properties':{'task':{'type':'object','required':['id'],'properties':{'id':{'type':'string','minLength':1}},'additionalProperties':False}},'additionalProperties':False}
        self.assertEqual([],validate_schema({'task':{'id':'SYN-1'}},s))
        for value in ({},{'task':{}},{'task':{'id':'','foreign':True}},{'task':[]}):self.assertTrue(validate_schema(value,s))
    def test_boolean_is_not_an_integer_or_numeric_enum(self):
        self.assertTrue(validate_schema(True,{'type':'integer','minimum':1}))
        self.assertTrue(validate_schema(True,{'enum':[1]}))
        self.assertEqual([],validate_schema(1,{'type':'integer','minimum':1}))
        self.assertEqual([],validate_schema(10**400,{'type':'integer'}))
        self.assertTrue(validate_schema({'ok':True},{'const':{'ok':1}}))
    def test_references_allof_and_conditional_confirmation(self):
        s={'$defs':{'identity':{'type':'object','required':['id'],'properties':{'id':{'type':'string','pattern':'^[A-Z]+@[1-9][0-9]*$'}}}},'allOf':[{'$ref':'#/$defs/identity'}],'if':{'properties':{'status':{'const':'completed'}},'required':['status']},'then':{'required':['confirmed'],'properties':{'confirmed':{'const':True}}}}
        self.assertEqual([],validate_schema({'id':'CARD@1','status':'completed','confirmed':True},s))
        self.assertEqual([],validate_schema({'id':'CARD@1','status':'ready'},s))
        self.assertTrue(validate_schema({'id':'CARD@0','status':'completed'},s))
    def test_arrays_and_source_timestamp_are_not_coerced(self):
        s={'type':'array','minItems':1,'items':{'type':'string','format':'date-time'}}
        self.assertEqual([],validate_schema(['2026-10-18T10:00:00+08:00'],s))
        for value in ([],['2026-10-18'],[4],['bad']):self.assertTrue(validate_schema(value,s))
    def test_unsupported_vocabulary_or_external_reference_fails_closed(self):
        for s in ({'not':{}},{'$ref':'external-schema'},{'if':{'not':{}},'then':{}},{'additionalProperties':{'type':'string'}},{'format':'unknown'}):self.assertTrue(validate_schema({},s))
