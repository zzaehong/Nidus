import json
import threading
import unittest
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from unittest.mock import patch
from nidus.testing import temporary_vault
from nidus.application import Application, revision
from nidus.gui import GUIServer
from nidus.store import Store
from nidus.gateway import default_policy
from nidus.planning import PlanRuntime


class GUIModelTests(unittest.TestCase):
    def setUp(self):
        self.temp = temporary_vault()
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
        self.assertTrue(a['created_at'])
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
        self.temp = temporary_vault()
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
        for asset in ('app.js', 'style.css'):
            with self.request('/'+asset) as response:
                self.assertEqual(response.status,200)
                self.assertTrue(response.read())
        with self.request('/api/session') as response:
            self.assertEqual(json.load(response)['token'],self.server.token)
        with self.assertRaises(HTTPError) as error:
            self.request('/api/session',headers={'Host':'evil.example'})
        self.assertEqual(error.exception.code,403)
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




class GUIWorkflowTests(unittest.TestCase):
    setUp = GUIModelTests.setUp
    tearDown = GUIModelTests.tearDown

    def setup_runtime(self, final='COMPLETE', review='APPROVE'):
        from unittest.mock import Mock
        from nidus.gateway import Gateway
        import test_planning
        helper = test_planning.PlanTests()
        values=[helper.proposal(), helper.worker(), helper.review(review), helper.final(final)]
        adapter=Mock()
        adapter.generate.side_effect=[{'text':json.dumps(v),'finish_reason':'stop','model':'fake',
            'tokens':None,'estimated_cost_usd':None} for v in values]
        self.app.planner=PlanRuntime(self.store,Gateway(adapter))
        p=self.app.create_plan({'request':'Report','sources':['notes.md'],'policy':default_policy()})
        return p,adapter

    def run_until_attention_or_complete(self, p):
        return self.app.command('plans',p['id'],'run',{'revision':revision(self.store,self.store.get_plan(p['id']))})

    def resolve_permissions(self):
        for a in self.app.overview()['attentions']:
            if a['group']=='permission':
                self.app.command(a['entity'],a['id'],'decision',{'revision':a['revision'],'decision':'approve'})

    def advance(self, p, adapter):
        for _ in range(15):
            before=adapter.generate.call_count
            p=self.run_until_attention_or_complete(p)
            self.assertLessEqual(adapter.generate.call_count-before,1)
            self.resolve_permissions()
            if p['status']=='completed' or any(a['group']=='quality' for a in self.app.overview()['attentions']):
                return self.store.get_plan(p['id'])
        self.fail('Bounded test fixture exhausted')

    def test_complete_archive_immutable_and_projection(self):
        p,adapter=self.setup_runtime()
        p=self.advance(p,adapter)
        self.assertEqual(p['status'],'completed')
        overview=self.app.overview()
        self.assertEqual(overview['summary']['completed_plans'],1)
        self.assertEqual(overview['summary']['active_plans'],0)
        t=overview['tasks'][0]
        self.assertTrue(all(t['verification'].values()))
        self.assertTrue(t['completed_at'])
        self.assertTrue(t['last_run_at'])
        self.assertEqual(t['manager_review']['decision'],'APPROVE')
        self.assertEqual(overview['archived_plans'][0]['progress'],{'completed':1,'total':1})
        before=json.dumps(self.store.get_plan(p['id']),sort_keys=True)
        with self.assertRaises(ValueError):
            self.app.command('plans',p['id'],'decision',{'revision':revision(self.store,p),'decision':'resume','note':'No'})
        self.assertEqual(json.dumps(self.store.get_plan(p['id']),sort_keys=True),before)
        with self.assertRaises(ValueError):
            self.app.command('tasks',t['id'],'quality',{'revision':t['revision'],'decision':'rework','note':'No'})
        self.assertEqual(self.store.get(t['id'])['status'],'completed')

    def test_quality_cancel_then_plan_resume(self):
        p,adapter=self.setup_runtime(review='ESCALATE')
        p=self.advance(p,adapter)
        attentions=self.app.overview()['attentions']
        pa=next(a for a in attentions if a['entity']=='plans')
        ta=next(a for a in attentions if a['entity']=='tasks')
        self.assertEqual(pa['allowed_actions'],['cancel'])
        with self.assertRaisesRegex(ValueError,'Resolve the Task'):
            self.app.command('plans',p['id'],'decision',{'revision':pa['revision'],'decision':'resume','note':'Continue'})
        self.app.command('tasks',ta['id'],'quality',{'revision':ta['revision'],'decision':'cancel','note':'Test stop'})
        pa=self.app.detail('plans',p['id'])['human_attention']
        self.assertIn('resume',pa['allowed_actions'])
        result=self.app.command('plans',p['id'],'decision',{'revision':pa['revision'],'decision':'resume','note':'Task resolved'})
        self.assertEqual(result['status'],'active')
        self.assertEqual(self.store.get(ta['id'])['status'],'cancelled')

    def test_final_escalation_cancel(self):
        p,adapter=self.setup_runtime(final='ESCALATE')
        p=self.advance(p,adapter)
        a=self.app.detail('plans',p['id'])['human_attention']
        self.assertEqual(a['type'],'plan_escalate')
        result=self.app.command('plans',p['id'],'decision',{'revision':a['revision'],'decision':'cancel','note':'Stop here'})
        self.assertEqual(result['status'],'cancelled')
        self.assertEqual(self.store.get(p['tasks'][0])['status'],'completed')

    def test_ready_dependency_projection(self):
        import test_planning
        helper=test_planning.PlanTests()
        p,_=self.setup_runtime()
        with self.store.lock():
            self.app.planner.install(p,helper.proposal([helper.spec(),helper.spec(2,['T1'])]))
        board=self.app.detail('plans',p['id'])['board']
        self.assertEqual([t['local_key'] for t in board],['T1','T2'])
        self.assertEqual([t['ready'] for t in board],[True,False])
        self.assertEqual(board[1]['depends_on'],[board[0]['id']])
        self.assertEqual(board[1]['assigned_worker'],'worker-1')
        self.assertEqual(self.app.overview()['summary']['ready_tasks'],1)

    def test_overwrite_permission_uses_existing_runtime(self):
        (self.vault/'result.md').write_text('Original')
        with self.store.lock():
            task=self.store.submit('Report',['notes.md'],'result.md','do-now')
        self.app.runtime.run(task['id'])
        a=self.app.detail('tasks',task['id'])['human_attention']
        self.assertEqual(a['type'],'overwrite')
        self.app.command('tasks',task['id'],'decision',{'revision':a['revision'],'decision':'reject'})
        self.assertEqual((self.vault/'result.md').read_text(),'Original')
        self.assertEqual(self.store.get(task['id'])['status'],'cancelled')


class GUIHttpWorkflowTests(GUIServerTests):
    # Reuse HTTP lifecycle helpers without inheriting the security test methods twice.
    test_loopback_page_session_and_origin = None
    test_post_requires_session_and_exact_origin = None

    def post(self, path, data):
        with self.request(path, data, {'Origin':self.base,'X-Nidus-Token':self.server.token,
                                       'Content-Type':'application/json'}) as response:
            return json.load(response)

    def get(self, path):
        with self.request(path) as response:
            return json.load(response)

    def test_http_create_step_decide_archive_and_restart(self):
        import sys
        sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
        from gui_fixture import FakeModel
        from http.server import HTTPServer
        model=HTTPServer(('127.0.0.1',0),FakeModel)
        model.calls=0
        thread=threading.Thread(target=model.serve_forever,daemon=True)
        thread.start()
        try:
            (Path(self.temp.name)/'notes.md').write_text('Nidus stores task state locally in a vault.')
            policy={'routes':[{'name':'synthetic','kind':'local','provider':'fixture','model':'fake',
                              'base_url':'http://127.0.0.1:%d/v1'%model.server_port}]}
            p=self.post('/api/plans',{'request':'HTTP synthetic report','sources':['notes.md'],'policy':policy})
            for _ in range(15):
                detail=self.get('/api/plans/'+p['id'])
                before=model.calls
                p=self.post('/api/plans/'+p['id']+'/run',{'revision':detail['revision']})
                self.assertLessEqual(model.calls-before,1)
                for a in self.get('/api/overview')['attentions']:
                    self.post('/api/'+a['entity']+'/'+a['id']+'/decision',{'decision':'approve','revision':a['revision']})
                if p['status']=='completed':
                    break
                self.assertNotEqual(p['status'],'blocked',p.get('error'))
            self.assertEqual(p['status'],'completed')
            self.assertEqual(model.calls,4)
            before=self.get('/api/overview')
            self.assertEqual(before['summary']['completed_plans'],1)
            # A new server token does not affect persisted Runtime state.
            old_token=self.server.token
            self.server.shutdown(); self.server.server_close(); self.thread.join()
            self.server=GUIServer(self.temp.name,0)
            self.base=self.server.origin
            self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
            self.assertEqual(self.get('/api/overview'),before)
            database=(Path(self.temp.name)/'.nidus/state.sqlite3').read_bytes()
            self.assertNotIn(self.server.token.encode(),database)
            self.assertNotIn(old_token.encode(),database)
        finally:
            model.shutdown();model.server_close();thread.join()

    def test_session_material_cannot_be_persisted(self):
        with self.assertRaises(HTTPError) as error:
            self.post('/api/plans',{'request':self.server.token,'sources':['notes.md'],'policy':default_policy()})
        self.assertEqual(error.exception.code,400)
        self.assertNotIn(self.server.token,error.exception.read().decode())

    def test_http_stale_and_path_traversal_structured(self):
        root=Path(self.temp.name)
        (root/'notes.md').write_text('Original')
        p=self.post('/api/plans',{'request':'Report','sources':['notes.md'],'policy':default_policy()})
        detail=self.get('/api/plans/'+p['id'])
        (root/'notes.md').write_text('Changed')
        with self.assertRaises(HTTPError) as error:
            self.post('/api/plans/'+p['id']+'/run',{'revision':detail['revision']})
        self.assertEqual(error.exception.code,409)
        self.assertEqual(json.load(error.exception)['error'],'STALE_STATE')
        with self.assertRaises(HTTPError):
            self.post('/api/plans',{'request':'Escape','sources':['../notes.md'],'policy':default_policy()})
        with self.assertRaises(HTTPError) as error:
            self.request('/api/plans/%2e%2e')
        self.assertEqual(error.exception.code,400)


if __name__ == '__main__':
    unittest.main()
