import tempfile
import unittest
from pathlib import Path
from nidus.store import Store
from nidus.runtime import Runtime


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.vault = Path(self.temp.name)
        (self.vault / 'notes.md').write_text('# Notes\n\nalpha\nbeta\ngamma\n', encoding='utf-8')
        self.store = Store(self.vault)

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def submit(self, output='brief.md', sources=None):
        return self.store.submit('Brief the notes', sources or ['notes.md'], output, 'do-now')

    def test_contract_and_complete(self):
        task = self.submit()
        self.assertEqual(set(task['contract']), {'goal', 'scope', 'constraints', 'acceptance_criteria', 'verification', 'result'})
        original = (self.vault / 'notes.md').read_bytes()
        result = Runtime(self.store).run(task['id'])
        self.assertEqual(result['status'], 'completed')
        self.assertTrue(all(result['verification'].values()))
        self.assertEqual((self.vault / 'notes.md').read_bytes(), original)
        self.assertIn('alpha', (self.vault / 'brief.md').read_text())
        self.assertEqual(self.store.tasks(), [])
        self.assertEqual(self.store.tasks(True)[0]['id'], task['id'])

    def test_restart_verification(self):
        task = self.submit()
        self.assertEqual(Runtime(self.store).run(task['id'], True)['status'], 'verifying')
        self.store.close()
        self.store = Store(self.vault)
        self.assertEqual(Runtime(self.store).run(task['id'])['status'], 'completed')

    def test_tampered_candidate_blocks(self):
        task = self.submit()
        Runtime(self.store).run(task['id'], True)
        (self.vault / 'brief.md').write_text('tampered')
        self.assertEqual(Runtime(self.store).run(task['id'])['status'], 'blocked')
        self.assertIsNone(self.store.get(task['id'])['contract']['result'])

    def test_changed_source_blocks(self):
        task = self.submit()
        Runtime(self.store).run(task['id'], True)
        (self.vault / 'notes.md').write_text('changed')
        self.assertEqual(Runtime(self.store).run(task['id'])['status'], 'blocked')

    def test_lock(self):
        second = Store(self.vault)
        try:
            with self.store.lock():
                with self.assertRaisesRegex(ValueError, 'Another runtime'):
                    with second.lock():
                        pass
        finally:
            second.close()

    def test_source_overwrite_denied(self):
        task = self.submit('notes.md')
        self.assertEqual(Runtime(self.store).run(task['id'])['status'], 'blocked')
