import copy
import io
import json
import os
import socket
import unittest
import urllib.error
from unittest.mock import patch
from nidus.gateway import (ChatCompletions, Gateway, ModelError, default_policy,
                           load_policy, transmission, validate_policy)


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.policy = validate_policy(default_policy())
        self.route = self.policy['routes'][0]
        self.task = {'id': 'task', 'request': 'Summarize', 'required_phrases': ['Nidus'], 'model_policy': self.policy}
        self.records = [{'path': 'notes.md', 'hash': 'hash', 'text': 'Nidus is local.'}]

    def response(self, content='Nidus is local.', finish='stop', **kwargs):
        value = {'model': 'actual-model', 'choices': [{'message': {'content': content}, 'finish_reason': finish}],
                 'usage': {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15}}
        value.update(kwargs)
        return io.BytesIO(json.dumps(value).encode())

    def test_transport_headers_and_usage_are_separated(self):
        with patch.dict(os.environ, {'NIDUS_MODEL_API_KEY': 'SENSITIVE_TEST_KEY'}):
            with patch('urllib.request.OpenerDirector.open', return_value=self.response()) as opened:
                result = ChatCompletions().generate(self.route, [{'role': 'user', 'content': 'Nidus'}], self.policy)
                request = opened.call_args.args[0]
                self.assertEqual(request.headers['Authorization'], 'Bearer SENSITIVE_TEST_KEY')
                self.assertNotIn(b'SENSITIVE_TEST_KEY', request.data)
                self.assertNotIn('SENSITIVE_TEST_KEY', json.dumps(result))
                self.assertEqual(result['estimated_cost_usd'], 0)
                self.assertEqual(result['tokens']['total_tokens'], 15)

    def test_http_failure_codes_do_not_echo_error_body(self):
        cases = [(401, 'authentication_failed', False), (403, 'access_denied', False),
                 (402, 'quota_exhausted', True), (429, 'rate_limited', True),
                 (500, 'provider_unavailable', True), (504, 'timeout', True), (302, 'redirect_denied', False)]
        for status, code, retryable in cases:
            with self.subTest(status=status):
                body = io.BytesIO(b'SENSITIVE_TEST_KEY in provider error')
                error = urllib.error.HTTPError('https://provider.invalid', status, 'error', {}, body)
                with patch('urllib.request.OpenerDirector.open', side_effect=error):
                    with self.assertRaises(ModelError) as caught:
                        ChatCompletions().generate(self.route, [], self.policy)
                    self.assertEqual(caught.exception.code, code)
                    self.assertEqual(caught.exception.retryable, retryable)
                    self.assertEqual(caught.exception.metadata()['http_status'], status)
                    self.assertNotIn('SENSITIVE_TEST_KEY', str(caught.exception))

    def test_timeout_and_network_failure(self):
        for error, code in [(socket.timeout(), 'timeout'), (urllib.error.URLError('private error'), 'network_failure')]:
            with patch('urllib.request.OpenerDirector.open', side_effect=error):
                with self.assertRaises(ModelError) as caught:
                    ChatCompletions().generate(self.route, [], self.policy)
                self.assertEqual(caught.exception.code, code)

    def test_invalid_response_and_unknown_usage(self):
        responses = [io.BytesIO(b'bad json'), self.response('', 'stop'), self.response('Nidus', 'length'),
                     self.response(usage={'prompt_tokens': '10'}), self.response(choices=[]),
                     self.response(usage={'completion_tokens': -1})]
        for response in responses:
            with patch('urllib.request.OpenerDirector.open', return_value=response):
                with self.assertRaises(ModelError):
                    ChatCompletions().generate(self.route, [], self.policy)
        with patch('urllib.request.OpenerDirector.open', return_value=self.response(usage=None)):
            result = ChatCompletions().generate(self.route, [], self.policy)
            self.assertIsNone(result['estimated_cost_usd'])
            self.assertIsNone(result['tokens']['total_tokens'])

    def test_credential_rejected_from_prompt_and_response(self):
        with patch.dict(os.environ, {'NIDUS_MODEL_API_KEY': 'SENSITIVE_TEST_KEY'}):
            self.records[0]['text'] = 'SENSITIVE_TEST_KEY'
            with self.assertRaisesRegex(ModelError, 'credential_in_content'):
                transmission(self.task, self.records)
            with patch('urllib.request.OpenerDirector.open', return_value=self.response('SENSITIVE_TEST_KEY')):
                with self.assertRaises(ModelError):
                    ChatCompletions().generate(self.route, [], self.policy)

    def test_unsafe_and_inline_secret_policy_denied(self):
        changes = [{'base_url': 'http://remote.example/v1'}, {'base_url': 'https://user:secret@example.com/v1'},
                   {'base_url': 'https://example.com/v1?key=secret'}, {'api_key': 'inline'},
                   {'api_key_env': 'HOME'}, {'kind': 'paid'}, {'kind': 'local'},
                   {'cost_per_million_input': float('nan')}]
        for change in changes:
            with self.subTest(change=change):
                policy = copy.deepcopy(self.policy)
                policy['routes'][0].update(change)
                with self.assertRaises(ModelError):
                    validate_policy(policy)
        policy = copy.deepcopy(self.policy)
        policy['allow_paid'] = True
        policy['routes'][0]['kind'] = 'paid'
        self.assertEqual(validate_policy(policy)['routes'][0]['kind'], 'paid')

    def test_ordered_retryable_fallback_and_auth_stop(self):
        self.policy['routes'].append(dict(self.route, name='second'))
        self.task['model_policy'] = self.policy
        events = []
        fake = unittest.mock.Mock()
        fake.generate.side_effect = [ModelError('rate_limited', True),
            {'text': 'Nidus summary', 'model': 'actual', 'finish_reason': 'stop', 'tokens': None, 'estimated_cost_usd': None}]
        result = Gateway(fake).generate(self.task, self.records, lambda *event: events.append(event))
        self.assertEqual(result['route'], 'second')
        self.assertEqual([call.args[0]['name'] for call in fake.generate.call_args_list], ['zen-free', 'second'])
        self.assertEqual([kind for kind, detail in events], ['model_attempt_started', 'model_attempt_failed',
                         'model_attempt_started', 'model_attempt_succeeded'])
        fake.reset_mock()
        fake.generate.side_effect = ModelError('authentication_failed')
        with self.assertRaises(ModelError):
            Gateway(fake).generate(self.task, self.records, lambda *event: None)
        self.assertEqual(fake.generate.call_count, 1)

    def test_failed_literal_contract_has_no_success_event(self):
        fake = unittest.mock.Mock()
        fake.generate.return_value = {'text': 'Unrelated', 'finish_reason': 'stop'}
        events = []
        with self.assertRaisesRegex(ModelError, 'acceptance_failed'):
            Gateway(fake).generate(self.task, self.records, lambda *event: events.append(event))
        self.assertNotIn('model_attempt_succeeded', [kind for kind, detail in events])
