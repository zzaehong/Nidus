import json
import subprocess
import sys
import unittest
from unittest.mock import patch
from pathlib import Path
import test_runtime


class ArchiveTests(unittest.TestCase):
    setUp = test_runtime.RuntimeTests.setUp
    tearDown = test_runtime.RuntimeTests.tearDown
    submit = test_runtime.RuntimeTests.submit

    def cli(self, *arguments, expected=0):
        result = subprocess.run([sys.executable, '-m', 'nidus', '--vault', str(self.vault), *arguments],
            capture_output=True, text=True)
        self.assertEqual(result.returncode, expected, result.stderr + result.stdout)
        return json.loads(result.stdout)

    def git(self, *arguments):
        return subprocess.run(['git', '-C', str(self.vault), *arguments], capture_output=True, text=True, check=True).stdout

    def test_separate_process_primary_flow_and_archive(self):
        task = self.cli('submit', '실제 문서 브리핑', '--source', 'notes.md', '--output', 'results/brief.md', '--priority', 'schedule')
        self.assertEqual(task['priority'], 'schedule')
        self.assertEqual(self.cli('run', task['id'], '--execute-only')['status'], 'verifying')
        self.assertEqual(self.cli('run', task['id'])['status'], 'completed')
        self.assertEqual(self.cli('list'), [])
        archived = self.cli('list', '--archive')[0]
        self.assertEqual(archived['id'], task['id'])
        inspected = self.cli('show', task['id'])
        self.assertTrue(inspected['contract']['result']['verification']['output_matches'])
        self.assertIn('verified_completed', [event['kind'] for event in inspected['history']])
        self.assertIn('results/brief.md', self.git('ls-files'))
        self.assertIn('notes.md', self.git('ls-files'))
        self.assertGreaterEqual(int(self.git('rev-list', '--count', 'HEAD')), 4)
        self.assertEqual(self.git('diff', 'HEAD', '--', '.nidus/state.sqlite3', 'results/brief.md'), '')

    def test_separate_process_approval_retains_preimage(self):
        (self.vault / 'brief.md').write_text('original')
        task = self.cli('submit', 'brief', '--source', 'notes.md', '--output', 'brief.md')
        self.assertEqual(self.cli('run', task['id'])['status'], 'waiting')
        self.cli('decide', task['id'], 'approve')
        self.assertEqual(self.cli('run', task['id'])['status'], 'completed')
        self.assertEqual(self.cli('show', task['id'])['decisions'][0]['decision'], 'approve')
        history = self.git('log', '--format=%H', '--', 'brief.md').splitlines()
        self.assertGreaterEqual(len(history), 2)
        self.assertEqual(self.git('show', history[1] + ':brief.md'), 'original')

    def test_unrelated_staged_file_preserved(self):
        (self.vault / 'personal.txt').write_text('user draft')
        self.git('add', 'personal.txt')
        self.cli('submit', 'brief', '--source', 'notes.md', '--output', 'brief.md')
        self.assertIn('personal.txt', self.git('diff', '--cached', '--name-only'))
        self.assertNotIn('personal.txt', self.git('ls-tree', '--name-only', 'HEAD'))

    def test_git_failure_cannot_leave_completed_task(self):
        from nidus.runtime import Runtime
        task = self.submit()
        original = self.store.versioning.checkpoint
        calls = []

        def fail_final(resources):
            calls.append(resources)
            if len(calls) == 2:
                raise ValueError('Vault Git failed: simulated failure')
            return original(resources)

        with patch.object(self.store.versioning, 'checkpoint', side_effect=fail_final):
            with self.assertRaisesRegex(ValueError, 'simulated failure'):
                Runtime(self.store).run(task['id'])
        self.assertEqual(self.store.get(task['id'])['status'], 'blocked')
        self.assertIsNone(self.store.get(task['id'])['contract']['result'])
        self.assertEqual(Runtime(self.store).run(task['id'])['status'], 'completed')
