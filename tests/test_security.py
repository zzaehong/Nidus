import unittest
import test_runtime
from nidus.runtime import Runtime, briefing, digest, sources_for


class SecurityTests(unittest.TestCase):
    setUp = test_runtime.RuntimeTests.setUp
    tearDown = test_runtime.RuntimeTests.tearDown
    submit = test_runtime.RuntimeTests.submit

    def test_approve_scoped_overwrite(self):
        (self.vault / 'brief.md').write_text('original')
        task = self.submit()
        runtime = Runtime(self.store)
        self.assertEqual(runtime.run(task['id'])['status'], 'waiting')
        self.assertEqual((self.vault / 'brief.md').read_text(), 'original')
        runtime.decide(task['id'], 'approve')
        self.assertEqual(runtime.run(task['id'])['status'], 'completed')

    def test_reject_preserves_output(self):
        (self.vault / 'brief.md').write_text('original')
        task = self.submit()
        runtime = Runtime(self.store)
        runtime.run(task['id'])
        runtime.decide(task['id'], 'reject')
        self.assertEqual(runtime.run(task['id'])['status'], 'cancelled')
        self.assertEqual((self.vault / 'brief.md').read_text(), 'original')

    def test_changed_approval_waits_again(self):
        for resource in ('notes.md', 'brief.md'):
            with self.subTest(resource=resource):
                (self.vault / 'brief.md').write_text('original')
                task = self.submit()
                runtime = Runtime(self.store)
                runtime.run(task['id'])
                runtime.decide(task['id'], 'approve')
                (self.vault / resource).write_text('new content')
                self.assertEqual(runtime.run(task['id'])['status'], 'waiting')

    def test_denied_paths(self):
        (self.vault / 'link.md').symlink_to(self.vault / 'notes.md')
        for source in ('../outside.md', '/tmp/outside.md', '.nidus/state.txt', 'link.md', 'missing.md'):
            with self.subTest(source=source):
                task = self.submit(sources=[source])
                self.assertEqual(Runtime(self.store).run(task['id'])['status'], 'blocked')
        for output in ('../escape.md', '/tmp/escape.md', '.secrets.md', 'link.md'):
            with self.subTest(output=output):
                task = self.submit(output)
                self.assertEqual(Runtime(self.store).run(task['id'])['status'], 'blocked')

    def test_desk_reconciliation_preserves_native_history(self):
        task = self.submit()
        self.store.set_state('desk:' + task['id'], {'board_status': 'completed', 'native_notes': ['remember this']})
        Runtime(self.store).run(task['id'])
        desk = self.store.state('desk:' + task['id'])
        self.assertEqual(desk['board_status'], 'completed')
        self.assertEqual(desk['native_notes'], ['remember this'])
        recovered = [e for e in self.store.events(task['id']) if e['kind'] == 'context_recovered'][0]
        self.assertEqual(recovered['data']['board_status'], 'queued')
        self.assertEqual(recovered['data']['order'], ['home', 'desk', 'task_board', 'library'])
        self.assertIsNone(self.store.state('home')['task'])
        self.assertGreaterEqual(len([e for e in self.store.events(task['id']) if e['kind'] == 'desk_checkpoint']), 3)

    def test_recover_write_before_candidate_commit(self):
        task = self.submit()
        records = sources_for(self.store, task)
        expected = briefing(task, records)
        task['status'] = 'running'
        task['write_intent'] = {'sources': {r['path']: r['hash'] for r in records}, 'expected_hash': digest(expected)}
        self.store.save(task, 'write_intent')
        (self.vault / 'brief.md').write_bytes(expected)
        self.assertEqual(Runtime(self.store).run(task['id'])['status'], 'completed')

    def test_missing_and_invalid_utf8_block(self):
        task = self.submit()
        Runtime(self.store).run(task['id'], True)
        (self.vault / 'brief.md').unlink()
        self.assertEqual(Runtime(self.store).run(task['id'])['status'], 'blocked')
        (self.vault / 'notes.md').write_bytes(b'\xff')
        self.assertEqual(Runtime(self.store).run(self.submit()['id'])['status'], 'blocked')

    def test_source_limit(self):
        (self.vault / 'notes.md').write_bytes(b'x' * (1024 * 1024 + 1))
        self.assertEqual(Runtime(self.store).run(self.submit()['id'])['status'], 'blocked')
