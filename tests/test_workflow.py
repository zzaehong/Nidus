import copy
import json
import unittest
from unittest.mock import Mock
import test_runtime
from nidus.gateway import Gateway, default_policy, messages_for, ModelError
from nidus.runtime import Runtime
from nidus.workflow import completion_contract, worker_submission


class WorkflowTests(unittest.TestCase):
    setUp = test_runtime.RuntimeTests.setUp
    tearDown = test_runtime.RuntimeTests.tearDown

    def submit(self, **kwargs):
        return self.store.submit('Summarize in exactly three bullets', ['notes.md'], 'managed.md', 'do-now',
            mode='generative', model_policy=default_policy(), workflow='manager', **kwargs)

    def submission(self, result='- alpha\n- beta\n- gamma'):
        return {'result': result, 'self_check': [
            {'criterion_id': 'C'+str(i), 'status':'satisfied', 'reason':'Checked against source'}
            for i in range(1,4)], 'known_limitations':[], 'questions':[]}

    def response(self, value):
        return {'text':json.dumps(value), 'finish_reason':'stop', 'model':'fake-model',
                'tokens':None, 'estimated_cost_usd':None}

    def test_contract_role_context_and_validation(self):
        task = self.submit()
        self.assertEqual(task['manager'], 'manager-1')
        self.assertEqual(task['rework_count'], 0)
        self.assertEqual(task['manager_contract']['expected_deliverable'], 'managed.md')
        messages = messages_for(task, [])
        self.assertIn('Worker', messages[0]['content'])
        self.assertIn('completion_criteria', messages[1]['content'])
        task['generation'] = self.response(self.submission())
        self.assertEqual(worker_submission(task)['result'], self.submission()['result'])
        task['generation'] = self.response(dict(self.submission(), self_check=[]))
        with self.assertRaises(ModelError):
            worker_submission(task)
        contract = copy.deepcopy(task['manager_contract'])
        contract['completion_criteria'][1]['id'] = 'C1'
        with self.assertRaises(ValueError):
            completion_contract(task['request'], task['sources'], task['output'], contract)
        for limit in (-1,11,True):
            with self.assertRaises(ValueError):
                self.submit(max_reworks=limit)
