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

    def decision(self, choice='APPROVE'):
        return {'decision':choice, 'criteria': self.submission()['self_check'],
            'reason':'Compared original request and each criterion with actual output and sources',
            'issues':['Only two bullets'] if choice == 'REWORK' else [],
            'instructions':['Write exactly three supported bullets'] if choice == 'REWORK' else [],
            'questions':['Which value should take precedence?'] if choice == 'ESCALATE' else []}

    def runtime(self, values):
        adapter = Mock()
        adapter.generate.side_effect = [self.response(value) for value in values]
        return Runtime(self.store, Gateway(adapter)), adapter

    def advance(self, runtime, task, review_only=False):
        for _ in range(15):
            result = runtime.run(task['id'], review_only=review_only)
            if result['status'] != 'waiting' or result['attention'].get('kind') == 'quality':
                return result
            runtime.decide(task['id'], 'approve')
        self.fail('Unbounded workflow')

    def test_manager_approval_completion_and_role_separation(self):
        task = self.submit()
        runtime, adapter = self.runtime([self.submission(), self.decision()])
        result = self.advance(runtime, task)
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['workflow_stage'], 'done')
        self.assertEqual(len(self.store.tasks(True)), 1)
        self.assertEqual(adapter.generate.call_count, 2)
        worker = adapter.generate.call_args_list[0].args[1]
        manager = adapter.generate.call_args_list[1].args[1]
        self.assertNotEqual(worker[0]['content'], manager[0]['content'])
        self.assertIn('worker_submission', manager[1]['content'])
        self.assertIn('original_request', manager[1]['content'])
        self.assertIn('manager_approved', [e['kind'] for e in self.store.events(task['id'])])

    def test_review_requires_separate_transmission_approval(self):
        task = self.submit()
        runtime, adapter = self.runtime([self.submission(), self.decision()])
        runtime.run(task['id'])
        runtime.decide(task['id'], 'approve')
        waiting = runtime.run(task['id'])
        self.assertEqual(waiting['status'], 'waiting')
        self.assertEqual(waiting['attention']['role'], 'manager')
        self.assertEqual(adapter.generate.call_count, 1)
        runtime.decide(task['id'], 'reject')
        self.assertEqual(runtime.run(task['id'])['status'], 'cancelled')
        self.assertEqual(adapter.generate.call_count, 1)

    def test_approved_result_tampering_invalidates_and_blocks(self):
        task = self.submit()
        runtime, adapter = self.runtime([self.submission(), self.decision()])
        result = self.advance(runtime, task, review_only=True)
        self.assertEqual(result['status'], 'verifying')
        self.assertIn('manager_approval', result)
        (self.vault / 'managed.md').write_text('tampered after approval')
        blocked = runtime.run(task['id'])
        self.assertEqual(blocked['status'], 'blocked')
        self.assertNotIn('manager_approval', blocked)
        self.assertEqual(adapter.generate.call_count, 2)

    def test_review_restart_does_not_repeat_models(self):
        task = self.submit()
        runtime, adapter = self.runtime([self.submission(), self.decision()])
        self.advance(runtime, task, review_only=True)
        self.store.close()
        self.store = test_runtime.Store(self.vault)
        replacement, fake = self.runtime([])
        self.assertEqual(replacement.run(task['id'])['status'], 'completed')
        fake.generate.assert_not_called()

    def test_escalation_never_completes_or_uses_permission_decision(self):
        task = self.submit()
        runtime, adapter = self.runtime([self.submission(), self.decision('ESCALATE')])
        result = self.advance(runtime, task)
        self.assertEqual(result['status'], 'waiting')
        self.assertEqual(result['workflow_stage'], 'human_review')
        self.assertEqual(len(self.store.tasks(True)), 0)
        with self.assertRaises(ValueError):
            runtime.decide(task['id'], 'approve')

    def test_wrong_result_requests_rework_and_retains_history_then_succeeds(self):
        task = self.submit()
        runtime, adapter = self.runtime([self.submission('- alpha\n- beta'), self.decision('REWORK'),
                                         self.submission(), self.decision()])
        rework = self.advance(runtime, task)
        self.assertEqual(rework['status'], 'queued')
        self.assertEqual(rework['rework_count'], 1)
        self.assertEqual(rework['workflow_stage'], 'rework')
        self.assertEqual(len(self.store.tasks(True)), 0)
        result = self.advance(runtime, task)
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(len(result['revisions']), 1)
        self.assertEqual(len(result['reviews']), 2)
        revised_prompt = adapter.generate.call_args_list[2].args[1][1]['content']
        self.assertIn('previous_result', revised_prompt)
        self.assertIn('Write exactly three supported bullets', revised_prompt)
        self.assertIn('- alpha\\n- beta', revised_prompt)

    def test_rework_limit_escalates_without_extra_call(self):
        task = self.submit(max_reworks=1)
        runtime, adapter = self.runtime([self.submission('- alpha'), self.decision('REWORK'),
                                         self.submission('- beta'), self.decision('REWORK')])
        self.advance(runtime, task)
        result = self.advance(runtime, task)
        self.assertEqual(result['status'], 'waiting')
        self.assertEqual(result['workflow_stage'], 'human_review')
        self.assertEqual(result['rework_count'], 1)
        self.assertIn('limit', result['attention']['reason'])
        runtime.run(task['id'])
        self.assertEqual(adapter.generate.call_count, 4)
        self.assertEqual(len(self.store.tasks(True)), 0)
        with self.assertRaises(ValueError):
            runtime.quality_decide(task['id'], 'rework', 'Try again', ['Fix it'])

    def test_human_quality_approval_and_cancel(self):
        for choice in ('approve','cancel'):
            with self.subTest(choice=choice):
                if (self.vault / 'managed.md').exists():
                    (self.vault / 'managed.md').unlink()
                task = self.submit()
                runtime, adapter = self.runtime([self.submission(), self.decision('ESCALATE')])
                self.advance(runtime, task)
                runtime.quality_decide(task['id'], choice, 'Human accepts responsibility for this judgment')
                result = runtime.run(task['id'])
                self.assertEqual(result['status'], 'completed' if choice == 'approve' else 'cancelled')
                self.assertEqual(adapter.generate.call_count, 2)
                if choice == 'approve':
                    self.assertEqual(result['manager_approval']['authority'], 'human')

    def test_human_rework_and_changed_scope_reject_stale_decision(self):
        task = self.submit()
        runtime, adapter = self.runtime([self.submission(), self.decision('ESCALATE'),
                                         self.submission(), self.decision()])
        self.advance(runtime, task)
        runtime.quality_decide(task['id'], 'rework', 'Use clearer wording', ['Clarify third bullet'])
        result = self.advance(runtime, task)
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['revisions'][0]['authority'], 'human')

        (self.vault / 'managed.md').unlink()
        task = self.submit()
        runtime, adapter = self.runtime([self.submission(), self.decision('ESCALATE')])
        self.advance(runtime, task)
        (self.vault / 'notes.md').write_text('changed evidence')
        with self.assertRaises(ValueError):
            runtime.quality_decide(task['id'], 'approve', 'stale approval')
        self.assertEqual(self.store.get(task['id'])['status'], 'waiting')
        runtime.quality_decide(task['id'], 'cancel', 'Cancel stale task')

    def test_manager_policy_change_reasks_and_never_uses_worker_approval(self):
        task = self.submit()
        runtime, adapter = self.runtime([self.submission(), self.decision()])
        runtime.run(task['id'])
        runtime.decide(task['id'], 'approve')
        runtime.run(task['id'])
        runtime.decide(task['id'], 'approve')
        changed = self.store.get(task['id'])
        changed['manager_policy']['routes'][0]['model'] = 'new-manager-model'
        self.store.save(changed, 'policy_changed')
        result = runtime.run(task['id'])
        self.assertEqual(result['status'], 'waiting')
        self.assertEqual(adapter.generate.call_count, 1)
        self.assertEqual(result['attention']['role'], 'manager')
