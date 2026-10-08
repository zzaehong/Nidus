import copy
import json
import os
import unittest
from unittest.mock import Mock, patch
import test_runtime
from nidus.gateway import Gateway, ModelError, default_policy
from nidus.runtime import Runtime


class GenerativeTests(unittest.TestCase):
    setUp = test_runtime.RuntimeTests.setUp
    tearDown = test_runtime.RuntimeTests.tearDown

    def submit(self, output='generated.md', phrases=None):
        return self.store.submit('Summarize Nidus notes', ['notes.md'], output, 'do-now',
            mode='generative', model_policy=default_policy(), required_phrases=phrases or ['Nidus'])

    def adapter(self, text='Nidus summary: alpha and beta.'):
        fake = Mock()
        fake.generate.return_value = {'text': text, 'finish_reason': 'stop', 'model': 'fake-model',
            'tokens': {'prompt_tokens': 20, 'completion_tokens': 10, 'total_tokens': 30}, 'estimated_cost_usd': 0}
        return fake

    def approve_network(self, runtime, task):
        waiting = runtime.run(task['id'])
        self.assertEqual(waiting['status'], 'waiting')
        self.assertEqual(waiting['attention']['snapshot']['action'], 'model_transmission')
        runtime.decide(task['id'], 'approve')

    def test_permission_generated_completion_and_audit(self):
        task = self.submit()
        fake = self.adapter()
        runtime = Runtime(self.store, Gateway(fake))
        self.approve_network(runtime, task)
        fake.generate.assert_not_called()
        completed = runtime.run(task['id'])
        self.assertEqual(completed['status'], 'completed')
        self.assertTrue(all(completed['verification'].values()))
        self.assertEqual(fake.generate.call_count, 1)
        self.assertIn('Nidus summary', (self.vault / 'generated.md').read_text())
        self.assertEqual(self.store.tasks(), [])
        history = self.store.events(task['id'])
        self.assertIn('model_attempt_succeeded', [e['kind'] for e in history])
        attempt = next(e['data'] for e in history if e['kind'] == 'model_attempt_succeeded')
        self.assertEqual(attempt['tokens']['total_tokens'], 30)
        self.assertIn('prompt_hash', attempt)
        self.assertNotIn('text', attempt)

    def test_changed_source_and_policy_invalidate_approval(self):
        for change in ('source', 'policy'):
            with self.subTest(change=change):
                task = self.submit()
                fake = self.adapter()
                runtime = Runtime(self.store, Gateway(fake))
                self.approve_network(runtime, task)
                if change == 'source':
                    (self.vault / 'notes.md').write_text('new source')
                else:
                    changed = self.store.get(task['id'])
                    changed['model_policy']['routes'][0]['model'] = 'another-free-model'
                    self.store.save(changed, 'test_policy_changed')
                self.assertEqual(runtime.run(task['id'])['status'], 'waiting')
                fake.generate.assert_not_called()

    def test_reject_has_no_network_or_file_write(self):
        task = self.submit()
        fake = self.adapter()
        runtime = Runtime(self.store, Gateway(fake))
        runtime.run(task['id'])
        runtime.decide(task['id'], 'reject')
        self.assertEqual(runtime.run(task['id'])['status'], 'cancelled')
        fake.generate.assert_not_called()
        self.assertFalse((self.vault / 'generated.md').exists())

    def test_overwrite_permission_precedes_transmission(self):
        (self.vault / 'generated.md').write_text('original')
        task = self.submit()
        fake = self.adapter()
        runtime = Runtime(self.store, Gateway(fake))
        first = runtime.run(task['id'])
        self.assertEqual(first['attention']['subject'], 'Replace existing output?')
        fake.generate.assert_not_called()
        runtime.decide(task['id'], 'approve')
        self.approve_network(runtime, task)
        fake.generate.assert_not_called()
        self.assertEqual(runtime.run(task['id'])['status'], 'completed')

    def test_restart_verifies_without_provider(self):
        task = self.submit()
        fake = self.adapter()
        runtime = Runtime(self.store, Gateway(fake))
        self.approve_network(runtime, task)
        self.assertEqual(runtime.run(task['id'], True)['status'], 'verifying')
        self.store.close()
        self.store = test_runtime.Store(self.vault)
        offline = self.adapter()
        self.assertEqual(Runtime(self.store, Gateway(offline)).run(task['id'])['status'], 'completed')
        offline.generate.assert_not_called()

    def test_saved_generation_recovers_write_intent(self):
        task = self.submit()
        fake = self.adapter()
        runtime = Runtime(self.store, Gateway(fake))
        self.approve_network(runtime, task)
        runtime.run(task['id'], True)
        changed = self.store.get(task['id'])
        changed['status'] = 'running'
        self.store.save(changed, 'simulated_crash_after_write')
        fake.reset_mock()
        self.assertEqual(runtime.run(task['id'])['status'], 'completed')
        fake.generate.assert_not_called()

    def test_tampered_candidate_and_changed_sources_never_complete(self):
        for target in ('generated.md', 'notes.md'):
            with self.subTest(target=target):
                task = self.submit(output='generated.md' if target == 'generated.md' else 'other.md')
                fake = self.adapter()
                runtime = Runtime(self.store, Gateway(fake))
                self.approve_network(runtime, task)
                runtime.run(task['id'], True)
                (self.vault / target).write_text('tampered')
                self.assertEqual(runtime.run(task['id'])['status'], 'blocked')
                self.assertIsNone(self.store.get(task['id'])['contract']['result'])

    def test_failures_and_bad_contract_block(self):
        for code, retryable in [('authentication_failed', False), ('timeout', True), ('rate_limited', True)]:
            with self.subTest(code=code):
                task = self.submit()
                fake = self.adapter()
                fake.generate.side_effect = ModelError(code, retryable)
                runtime = Runtime(self.store, Gateway(fake))
                self.approve_network(runtime, task)
                result = runtime.run(task['id'])
                self.assertEqual(result['status'], 'blocked')
                self.assertEqual(result['model_error']['code'], code)
                self.assertEqual(result['model_error']['retryable'], retryable)
                self.assertFalse((self.vault / 'generated.md').exists())
        task = self.submit()
        fake = self.adapter(text='Unrelated content')
        runtime = Runtime(self.store, Gateway(fake))
        self.approve_network(runtime, task)
        self.assertEqual(runtime.run(task['id'])['status'], 'blocked')

    def test_credential_not_persisted_or_transmitted(self):
        with patch.dict(os.environ, {'NIDUS_MODEL_API_KEY': 'SENSITIVE_TEST_KEY'}):
            with self.assertRaises(ModelError):
                self.store.submit('SENSITIVE_TEST_KEY', ['notes.md'], 'generated.md', 'later',
                    mode='generative', model_policy=default_policy())
            task = self.submit()
            (self.vault / 'notes.md').write_text('SENSITIVE_TEST_KEY')
            fake = self.adapter()
            result = Runtime(self.store, Gateway(fake)).run(task['id'])
            self.assertEqual(result['status'], 'blocked')
            fake.generate.assert_not_called()
            self.assertNotIn('SENSITIVE_TEST_KEY', json.dumps(self.store.get(task['id'])))
            self.assertNotIn('SENSITIVE_TEST_KEY', json.dumps(self.store.events(task['id'])))
            self.assertNotIn(b'SENSITIVE_TEST_KEY', (self.vault / '.nidus/state.sqlite3').read_bytes())
