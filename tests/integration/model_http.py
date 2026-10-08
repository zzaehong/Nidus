"""Offline loopback integration; needs local socket permission, never external APIs."""
import json
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        self.server.calls.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
        self.send_response(self.server.response_status)
        if self.server.response_status == 302:
            self.send_header('Location', 'http://127.0.0.1:%d/other/chat/completions' % self.server.server_port)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        value = {'model': 'loopback-fake', 'choices': [{'message': {'content': 'Nidus keeps tasks local and verifies completion.'},
                 'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 25, 'completion_tokens': 12, 'total_tokens': 37}}
        if self.server.response_status != 200:
            value = {'error': 'SENSITIVE_TEST_KEY must never be persisted from an error body'}
        self.wfile.write(json.dumps(value).encode())


class HttpIntegration(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.vault = self.root / 'vault'
        self.vault.mkdir()
        (self.vault / 'notes.md').write_text('Nidus sample facts.')
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.calls = []
        self.server.response_status = 200
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        policy = {'routes': [{'name': 'fake-local', 'kind': 'local', 'provider': 'loopback-fake',
            'model': 'fake', 'base_url': 'http://127.0.0.1:%d/v1' % self.server.server_port}]}
        self.policy = self.root / 'policy.json'
        self.policy.write_text(json.dumps(policy))

    def tearDown(self):
        self.server.shutdown()
        self.thread.join()
        self.server.server_close()
        self.temp.cleanup()

    def cli(self, *args, code=0):
        result = subprocess.run([sys.executable, '-m', 'nidus', '--vault', str(self.vault), *args],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, code, result.stderr + result.stdout)
        return json.loads(result.stdout)

    def prepare(self):
        task = self.cli('submit', 'Summarize Nidus', '--mode', 'generative', '--model-policy', str(self.policy),
                        '--source', 'notes.md', '--output', 'result.md', '--require', 'Nidus')
        self.assertEqual(self.cli('run', task['id'])['status'], 'waiting')
        self.assertEqual(len(self.server.calls), 0)
        self.cli('decide', task['id'], 'approve')
        return task

    def test_real_http_cli_restart_archive(self):
        task = self.prepare()
        self.assertEqual(self.cli('run', task['id'], '--execute-only')['status'], 'verifying')
        self.assertEqual(len(self.server.calls), 1)
        self.assertEqual(self.cli('run', task['id'])['status'], 'completed')
        self.assertEqual(len(self.server.calls), 1)
        self.assertEqual(self.cli('list'), [])
        self.assertEqual(len(self.cli('list', '--archive')), 1)
        payload = self.server.calls[0]
        self.assertEqual(payload['model'], 'fake')
        self.assertNotIn('home', payload['messages'][1]['content'])
        self.assertNotIn(str(self.vault), payload['messages'][1]['content'])

    def test_real_http_auth_failure_drops_body(self):
        task = self.prepare()
        self.server.response_status = 401
        result = self.cli('run', task['id'], code=2)
        self.assertEqual(result['model_error']['code'], 'authentication_failed')
        self.assertNotIn('SENSITIVE_TEST_KEY', json.dumps(self.cli('show', task['id'], code=2)))
        self.assertNotIn(b'SENSITIVE_TEST_KEY', (self.vault / '.nidus/state.sqlite3').read_bytes())
        self.assertFalse((self.vault / 'result.md').exists())

    def test_redirect_never_forwards_prompt(self):
        task = self.prepare()
        self.server.response_status = 302
        result = self.cli('run', task['id'], code=2)
        self.assertEqual(result['model_error']['code'], 'redirect_denied')
        self.assertEqual(len(self.server.calls), 1)


if __name__ == '__main__':
    unittest.main()
