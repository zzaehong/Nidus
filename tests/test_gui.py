import json
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from unittest.mock import patch
from nidus.application import Application, revision
from nidus.gui import GUIServer
from nidus.store import Store
from nidus.gateway import default_policy
from nidus.planning import PlanRuntime


class GUIModelTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.vault = Path(self.temp.name)
        (self.vault/'notes.md').write_text('Public synthetic facts')
        self.store = Store(self.vault)
        self.app = Application(self.store)

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def plan(self):
        return self.app.create_plan({'request':'Make report', 'sources':['notes.md'], 'policy':default_policy()})

    def test_dashboard_permission_and_restart(self):
        p = self.plan()
        self.app.command('plans', p['id'], 'run', {'revision':revision(self.store,p)})
        data = self.app.overview()
        self.assertEqual(data['summary'], {'active_plans':1,'human_attentions':1,'ready_tasks':0,'completed_plans':0})
        a = data['attentions'][0]
        self.assertEqual(a['allowed_actions'], ['approve','reject'])
        self.assertEqual(a['group'], 'permission')
        self.app.command('plans',p['id'],'decision', {'revision':a['revision'],'decision':'approve'})
        self.store.close()
        self.store = Store(self.vault)
        self.app = Application(self.store)
        self.assertEqual(self.app.overview()['plans'][0]['status'], 'planning')

    def test_one_run_one_runtime_call(self):
        p = self.plan()
        with patch.object(self.app.planner, 'run', return_value=p) as run:
            self.app.command('plans',p['id'],'run',{'revision':revision(self.store,p)})
        run.assert_called_once_with(p['id'], expected_state=revision(self.store,p))

    def test_stale_resource_decision_rejected(self):
        p = self.plan()
        self.app.planner.run(p['id'])
        a = self.app.overview()['attentions'][0]
        (self.vault/'notes.md').write_text('Changed facts')
        with self.assertRaisesRegex(ValueError,'STALE_STATE'):
            self.app.command('plans',p['id'],'decision',{'revision':a['revision'],'decision':'approve'})
        self.assertEqual(self.store.get_plan(p['id'])['status'],'waiting')

    def test_invalid_identity_and_source(self):
        with self.assertRaisesRegex(ValueError,'INVALID_ID'):
            self.app.detail('plans','../state')
        with self.assertRaises(ValueError):
            self.app.create_plan({'request':'x','sources':['../notes.md'],'policy':default_policy()})

    def test_task_permission_and_quality_separate(self):
        with self.store.lock():
            task = self.store.submit('Summarize',['notes.md'],'result.md','do-now')
            task.update(status='waiting', attention={'kind':'quality','choices':['approve','rework','cancel'],'snapshot':{}})
            self.store.save(task, 'test_quality')
        a = self.app.detail('tasks',task['id'])['human_attention']
        self.assertEqual(a['group'],'quality')
        with self.assertRaisesRegex(ValueError,'quality decision'):
            self.app.command('tasks',task['id'],'decision', {'revision':a['revision'],'decision':'approve'})
        with patch.object(self.app.runtime, 'quality_decide', return_value=task) as quality:
            self.app.command('tasks',task['id'],'quality', {'revision':a['revision'],'decision':'cancel','note':'Stop'})
        quality.assert_called_once()


class GUIServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.server = GUIServer(self.temp.name, 0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = self.server.origin

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, path, data=None, headers=None):
        req = Request(self.base+path, data=json.dumps(data).encode() if data is not None else None,
            headers=headers or {})
        return urlopen(req, timeout=5)

    def test_loopback_page_session_and_origin(self):
        self.assertEqual(self.server.server_address[0],'127.0.0.1')
        with self.request('/') as response:
            self.assertIn(b'NIDUS', response.read())
            self.assertIn('frame-ancestors', response.headers['Content-Security-Policy'])
        with self.request('/api/session') as response:
            self.assertEqual(json.load(response)['token'],self.server.token)
        for host in ('0.0.0.0','localhost','::1'):
            with self.assertRaises(ValueError):
                GUIServer(self.temp.name,0,host)
        with self.assertRaises(HTTPError) as error:
            self.request('/api/overview', headers={'Origin':'https://evil.example'})
        self.assertEqual(error.exception.code,403)

    def test_post_requires_session_and_exact_origin(self):
        for headers in ({}, {'Origin':self.base,'X-Nidus-Token':'wrong'},
                        {'Origin':'https://evil.example','X-Nidus-Token':self.server.token}):
            with self.assertRaises(HTTPError) as error:
                self.request('/api/plans', {}, dict(headers, **{'Content-Type':'application/json'}))
            self.assertEqual(error.exception.code,403)
        headers = {'Origin':self.base,'X-Nidus-Token':self.server.token,'Content-Type':'application/json'}
        with self.assertRaises(HTTPError) as error:
            self.request('/api/plans/../run',{},headers)
        self.assertEqual(error.exception.code,400)
        self.assertNotIn('Traceback',error.exception.read().decode())


if __name__ == '__main__':
    unittest.main()
