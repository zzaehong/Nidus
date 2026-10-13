import contextlib
import io
import json
import logging
import os
import threading
import uuid
import subprocess
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest.mock import patch
from nidus.connections import ConnectionRegistry
from nidus.credentials import EnvironmentCredentialProvider, validate_secret
from nidus.gateway import ModelError
from nidus.providers import ProviderRegistry, endpoint
from nidus.testing import temporary_vault
from nidus.store import Store


class MemoryCredentials:
    def __init__(self): self.values={}
    def put(self, ref, secret):
        validate_secret(secret)
        if ref in self.values: raise ModelError('credential_store_failure')
        self.values[ref]=secret
    def get(self, ref):
        if ref not in self.values: raise ModelError('credential_missing')
        return self.values[ref]
    def replace(self, ref, secret): self.get(ref); validate_secret(secret); self.values[ref]=secret
    def delete(self, ref): self.values.pop(ref,None)
    def exists(self, ref): return ref in self.values


class FakeProvider(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def respond(self, code, value):
        data=json.dumps(value).encode(); self.send_response(code); self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        self.server.calls.append(('GET',self.path))
        self.respond(self.server.discovery,{'data':[{'id':self.server.model}]})
    def do_POST(self):
        data=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.calls.append(('POST',data))
        if self.headers.get('Authorization')!='Bearer '+self.server.secret:
            return self.respond(401,{'error':self.server.secret})
        structured='response_format' in data
        self.respond(self.server.structured if structured else self.server.generation,
            {'model':self.server.model,'choices':[{'message':{'content':self.server.output if structured else self.server.plain},'finish_reason':'stop'}],
             'usage':{'prompt_tokens':8,'completion_tokens':3,'total_tokens':11}})


class FakeGemini(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def respond(self, code, value):
        data=json.dumps(value).encode(); self.send_response(code); self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        self.server.calls.append(('GET',self.path))
        if self.headers.get('x-goog-api-key')!=self.server.secret:
            return self.respond(401,{'error':{'message':'key rejected'}})
        if self.server.discovery_status!=200:
            return self.respond(self.server.discovery_status,{'error':{'message':'synthetic error'}})
        self.respond(200,{'models':self.server.models})
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        model=self.path.split('/models/',1)[1].split(':generateContent',1)[0]
        structured='responseFormat' in body.get('generationConfig',{})
        self.server.calls.append(('POST',model,structured,body))
        if self.headers.get('x-goog-api-key')!=self.server.secret:
            return self.respond(401,{'error':{'message':'key rejected'}})
        status=self.server.generate_status.get((model,structured),200)
        if status!=200: return self.respond(status,{'error':{'message':'synthetic error'}})
        text=self.server.outputs.get((model,structured),'READY' if not structured else '{"status":"READY"}')
        self.respond(200,{'candidates':[{'content':{'parts':[{'text':text}]},'finishReason':'STOP'}],
            'usageMetadata':{'promptTokenCount':5,'candidatesTokenCount':2,'totalTokenCount':7},
            'modelVersion':'actual-'+model})


class ConnectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp=temporary_vault(); self.store=Store(self.tmp.name); self.keys=MemoryCredentials()
        self.registry=ConnectionRegistry(self.store,self.keys)
        self.server=HTTPServer(('127.0.0.1',0),FakeProvider)
        self.server.discovery=200; self.server.generation=200; self.server.structured=200
        self.server.model='synthetic-model'; self.server.output='{"status":"READY"}'; self.server.plain='READY'
        self.server.secret='test-secret-'+uuid.uuid4().hex; self.server.calls=[]
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True); self.thread.start()
        self.url='http://127.0.0.1:'+str(self.server.server_port)+'/v1'
    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(); self.store.close(); self.tmp.cleanup()
    def create(self): return self.registry.create('openai-compatible',self.url,self.server.secret)
    def probe(self): return self.registry.probe(self.create()['id'])

    def test_success_restart_and_security(self):
        c=self.create(); self.assertEqual(c['status'],'configured')
        output=io.StringIO(); handler=logging.StreamHandler(output); logging.getLogger().addHandler(handler)
        try:
            result=self.registry.probe(c['id'])
        finally: logging.getLogger().removeHandler(handler)
        self.assertEqual(result['connection']['status'],'ready')
        self.assertEqual(result['models'][0]['capabilities'],{'chat':'verified','structured_output':'verified'})
        self.assertIsNone(result['models'][0]['price'])
        diff=subprocess.run(['git','diff','HEAD'],capture_output=True,check=True).stdout
        self.assertNotIn(self.server.secret.encode(),diff)
        self.assertEqual(len(self.registry.list_ready_connections()),1)
        self.assertEqual(len(self.registry.list_available_models(c['id'])),1)
        self.assertNotIn(self.server.secret,json.dumps(result)+output.getvalue()+json.dumps(self.server.calls))
        for path in Path(self.tmp.name).rglob('*'):
            if path.is_file(): self.assertNotIn(self.server.secret.encode(),path.read_bytes(),str(path))
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM tasks').fetchone()[0],0)
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM plans').fetchone()[0],0)
        self.store.close(); self.store=Store(self.tmp.name); self.registry=ConnectionRegistry(self.store,self.keys)
        self.assertEqual(self.registry.get(c['id'])['status'],'ready')
        self.assertEqual(self.registry.catalog(c['id']),result['models'])

    def test_crud(self):
        c=self.create(); d=self.create(); self.assertNotEqual(c['id'],d['id'])
        self.assertEqual(self.keys.get(c['credential_ref']),self.server.secret)
        self.registry.probe(c['id']); self.registry.update(c['id'],base_url=self.url,secret='replacement')
        self.assertEqual(self.keys.get(c['credential_ref']),'replacement')
        self.assertEqual(self.registry.get(c['id'])['status'],'configured'); self.assertEqual(self.registry.catalog(c['id']),[])
        self.assertEqual(self.registry.get(c['id'])['probe']['generation'],'not_run')
        self.registry.delete(c['id']); self.assertFalse(self.keys.exists(c['credential_ref']))
        with self.assertRaises(ModelError): self.registry.get(c['id'])
        with self.assertRaises(ModelError): self.keys.get(c['credential_ref'])

    def test_auth_no_fallback(self):
        self.server.generation=401; r=self.probe()
        self.assertEqual(r['connection']['status'],'blocked')
        self.assertEqual(r['connection']['last_error']['code'],'authentication_failed')
        self.assertEqual(len(self.server.calls),2)
        self.server.calls=[]; self.server.discovery=401; self.probe(); self.assertEqual(len(self.server.calls),1)

    def test_ready_connection_can_generate_plan_messages_from_keychain_reference(self):
        connection=self.probe()['connection']
        route={'name':'Synthetic model','kind':'local','provider':'openai-compatible',
            'base_url':connection['base_url'],'model':self.server.model,'connection_id':connection['id']}
        result=self.registry.generate_for_route(route,[{'role':'user','content':'Return READY'}],
            {'timeout_seconds':10,'max_tokens':32})
        self.assertEqual(result['text'],'READY')
        self.assertEqual(self.server.calls[-1][0],'POST')
        self.assertNotIn(self.server.secret,str(result))

    def test_temporary_failures(self):
        for status,code in [(429,'rate_limited'),(503,'provider_unavailable'),(504,'timeout'),(403,'access_denied')]:
            self.server.generation=status; r=self.probe()
            self.assertEqual(r['connection']['last_error']['code'],code)
            self.assertEqual(r['connection']['status'],'blocked' if status==403 else 'degraded')

    def test_discovery_failure_cached_candidate_only(self):
        c=self.create(); self.registry.probe(c['id']); self.server.discovery=404
        r=self.registry.probe(c['id']); self.assertEqual(r['connection']['status'],'ready')
        self.assertEqual(r['connection']['discovery']['status'],'failed')
        r=self.probe(); self.assertEqual(r['connection']['status'],'degraded')
        self.assertEqual(r['connection']['probe']['generation'],'not_run')

    def test_generation_and_structured_failures(self):
        self.server.plain='incorrect'; self.assertNotEqual(self.probe()['connection']['status'],'ready')
        self.server.plain='READY'
        for output in ['not JSON','{"status":"WRONG"}','{"status":"READY","extra":1}']:
            self.server.output=output; r=self.probe()
            self.assertEqual(r['connection']['status'],'degraded')
            self.assertEqual(r['models'][0]['capabilities']['structured_output'],'unverified')
        self.server.structured=400; self.assertEqual(self.probe()['connection']['status'],'degraded')

    def test_secret_echo_rejected(self):
        self.server.model=self.server.secret; r=self.probe()
        self.assertEqual(r['connection']['last_error']['code'],'credential_in_content')
        self.assertNotIn(self.server.secret,json.dumps(r))
        self.server.model='synthetic'; self.server.plain=self.server.secret
        self.assertEqual(self.probe()['connection']['last_error']['code'],'credential_in_content')
        with self.assertRaises(ModelError): self.registry.create('openai-compatible',self.url+'/'+self.server.secret,self.server.secret)

    def test_interrupted_probe(self):
        c=self.create(); c['status']='probing'; self.registry._save(c)
        r=ConnectionRegistry(self.store,self.keys).get(c['id'])
        self.assertEqual(r['status'],'degraded'); self.assertEqual(r['last_error']['code'],'probe_interrupted')

    def test_environment_compatibility(self):
        with patch.dict(os.environ,{'NIDUS_TEST_API_KEY':self.server.secret}):
            c=self.registry.create('openai-compatible',self.url,credential_ref='env:NIDUS_TEST_API_KEY')
            self.assertEqual(self.registry.probe(c['id'])['connection']['status'],'ready')
            self.registry.delete(c['id']); self.assertEqual(os.environ['NIDUS_TEST_API_KEY'],self.server.secret)
        with self.assertRaises(ModelError): EnvironmentCredentialProvider().get('env:PATH')

    def test_probing_observed_and_missing_credential_repair(self):
        c=self.create(); generate=self.registry.adapter.generate
        def observed(*args,**kwargs):
            self.assertEqual(self.registry.get(c['id'])['status'],'probing')
            return generate(*args,**kwargs)
        with patch.object(self.registry.adapter,'generate',side_effect=observed):
            self.assertEqual(self.registry.probe(c['id'])['connection']['status'],'ready')
        self.keys.delete(c['credential_ref'])
        self.assertEqual(self.registry.probe(c['id'])['connection']['last_error']['code'],'credential_missing')
        self.assertEqual(self.registry.list_available_models(c['id']),[])
        self.registry.update(c['id'],secret=self.server.secret)
        self.assertEqual(self.registry.probe(c['id'])['connection']['status'],'ready')

    def test_redirect_and_removed_model(self):
        c=self.create(); self.registry.probe(c['id']); self.server.model='replacement-model'
        result=self.registry.probe(c['id'])
        self.assertEqual(next(m for m in result['models'] if m['model_id']=='synthetic-model')['availability'],'unknown')
        self.server.generation=302
        self.assertEqual(self.registry.probe(c['id'])['connection']['last_error']['code'],'redirect_denied')

    def test_manifest_and_endpoints(self):
        manifests=ProviderRegistry().list(); self.assertEqual(len(manifests),3)
        self.assertEqual({m['id']:m['connection_kind'] for m in manifests},
            {'gemini':'direct','omniroute':'gateway','openai-compatible':'compatible'})
        for values in [manifests+[manifests[0]], [dict(manifests[0],auth_type='oauth')], [dict(manifests[0],protocol='')]]:
            with self.assertRaises(ModelError): ProviderRegistry(values)
        for url in ['http://example.com/v1','https://a:b@example.com/v1','https://example.com/v1?q=a',
                    'https://example.com/#x','http://[invalid','https://example.com:bad','https://example.com/\n']:
            with self.assertRaises(ModelError): endpoint(url)
        self.assertEqual(endpoint('https://example.com/v1/'),'https://example.com/v1')

    def test_manifest_adapter_dispatch(self):
        manifests=ProviderRegistry().list()
        self.assertEqual({item['id']:item['adapter'] for item in manifests},
                         {'gemini':'gemini','omniroute':'openai-compatible','openai-compatible':'openai-compatible'})
        class AlternateAdapter:
            def __init__(self): self.calls=[]
            def discover_models(self, connection, secret):
                self.calls.append(('discover',connection['provider']))
                return ['synthetic-alternate']
            def generate(self, connection, model, secret, structured=False):
                self.calls.append(('generate',connection['provider'],structured))
                return {'text':'{"status":"READY"}' if structured else 'READY',
                        'model':model,'tokens':{'total_tokens':1}}
        generic=next(m for m in manifests if m['id']=='openai-compatible')
        alt=dict(generic,id='alternate-provider',name='Alternate provider',adapter='alternate')
        alternate=AlternateAdapter()
        registry=ConnectionRegistry(self.store,self.keys,providers=[alt])
        with self.assertRaises(ModelError) as error:
            registry.create('alternate-provider',self.url,self.server.secret)
        self.assertEqual(error.exception.code,'unsupported_adapter')
        # Supplying both dispatch targets makes manifest selection observable.
        registry=ConnectionRegistry(self.store,self.keys,adapters={
            'openai-compatible':self.registry.adapter,'alternate':alternate},providers=[generic,alt])
        connection=registry.create('alternate-provider',self.url,self.server.secret)
        result=registry.probe(connection['id'])
        self.assertEqual(result['connection']['status'],'ready')
        self.assertEqual(alternate.calls,[('discover','alternate-provider'),
            ('generate','alternate-provider',False),('generate','alternate-provider',True)])

    def test_saved_omniroute_identity_is_preserved_and_kind_backfilled(self):
        connection=self.create()
        stored=self.registry.get(connection['id']); stored['provider']='omniroute'
        stored.pop('connection_kind',None)
        self.registry._save(stored)
        migrated=ConnectionRegistry(self.store,self.keys).get(connection['id'])
        self.assertEqual(migrated['provider'],'omniroute')
        self.assertEqual(migrated['connection_kind'],'gateway')
        self.assertEqual(migrated['credential_ref'],connection['credential_ref'])
        restarted=ConnectionRegistry(self.store,self.keys)
        self.assertEqual(restarted.get(connection['id']),migrated)
        self.assertEqual(restarted.probe(connection['id'])['connection']['status'],'ready')

    def test_connection_kind_mismatch_is_rejected_and_generic_endpoint_not_guessed(self):
        generic=self.registry.create('openai-compatible','http://127.0.0.1:20128/v1',self.server.secret)
        self.assertEqual(generic['connection_kind'],'compatible')
        self.assertEqual(generic['provider'],'openai-compatible')
        generic.pop('connection_kind')
        self.registry._save(generic)
        generic=ConnectionRegistry(self.store,self.keys).get(generic['id'])
        self.assertEqual((generic['provider'],generic['connection_kind']),('openai-compatible','compatible'))
        self.registry._save(dict(generic,connection_kind='gateway'))
        with self.assertRaises(ModelError) as error: self.registry.probe(generic['id'])
        self.assertEqual(error.exception.code,'connection_kind_mismatch')

    def test_legacy_gemini_and_generic_kinds_are_backfilled_from_provider(self):
        gemini=self.registry.create('gemini',secret='gemini-key')
        generic=self.registry.create('openai-compatible',self.url,self.server.secret)
        for connection in (gemini,generic):
            legacy=dict(connection); legacy.pop('connection_kind'); self.registry._save(legacy)
        restarted=ConnectionRegistry(self.store,self.keys)
        self.assertEqual(restarted.get(gemini['id'])['connection_kind'],'direct')
        self.assertEqual(restarted.get(generic['id'])['connection_kind'],'compatible')

    def test_direct_gateway_and_compatible_connections_coexist(self):
        gemini=self.registry.create('gemini',secret='gemini-key')
        generic=self.registry.create('openai-compatible',self.url,self.server.secret)
        gateway=self.registry.create('omniroute',self.url,self.server.secret)
        self.assertEqual({c['provider'] for c in self.registry.list()},
            {'gemini','openai-compatible','omniroute'})
        self.assertEqual({c['connection_kind'] for c in (gemini,generic,gateway)},
            {'direct','compatible','gateway'})

    def test_omniroute_reuses_compatible_discovery_generation_and_structured_probe(self):
        gateway=self.registry.create('omniroute',self.url,self.server.secret)
        result=self.registry.probe(gateway['id'])
        self.assertEqual(result['connection']['status'],'ready')
        self.assertEqual(result['connection']['provider'],'omniroute')
        self.assertEqual(result['models'][0]['capabilities'],
            {'chat':'verified','structured_output':'verified'})
        self.assertEqual([call[0] for call in self.server.calls],['GET','POST','POST'])


class GeminiConnectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp=temporary_vault(); self.store=Store(self.tmp.name); self.keys=MemoryCredentials()
        self.server=HTTPServer(('127.0.0.1',0),FakeGemini)
        self.server.secret='gemini-test-'+uuid.uuid4().hex
        self.server.discovery_status=200; self.server.generate_status={}; self.server.outputs={}; self.server.calls=[]
        self.server.models=[
            {'name':'models/embed-only','supportedGenerationMethods':['embedContent']},
            {'name':'models/gemini-a','supportedGenerationMethods':['generateContent']},
            {'name':'models/gemini-b','supportedGenerationMethods':['generateContent']},
        ]
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True); self.thread.start()
        self.url='http://127.0.0.1:'+str(self.server.server_port)+'/v1beta'
        providers=ProviderRegistry().list()
        providers[0]['default_base_url']=self.url
        self.registry=ConnectionRegistry(self.store,self.keys,providers=providers)
    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(); self.store.close(); self.tmp.cleanup()
    def create(self,secret=None):
        return self.registry.create('gemini',secret=self.server.secret if secret is None else secret)
    def probe(self): return self.registry.probe(self.create()['id'])

    def test_discovery_filters_and_structured_failure_tries_next(self):
        self.server.generate_status[('gemini-a',True)]=400
        result=self.probe(); connection=result['connection']
        self.assertEqual(connection['status'],'ready')
        self.assertEqual(connection['probe'],{'generation':'passed','structured_output':'passed'})
        self.assertEqual(connection['discovery']['count'],2)
        self.assertEqual([call[1] for call in self.server.calls if call[0]=='POST'],
            ['gemini-a','gemini-a','gemini-b','gemini-b'])
        selected=next(model for model in result['models'] if model['model_id']=='gemini-b')
        self.assertEqual(selected['availability'],'available')
        self.assertEqual(selected['actual_model'],'actual-gemini-b')
        self.assertEqual(selected['tokens']['total_tokens'],7)
        self.assertEqual(selected['capabilities'],{'chat':'verified','structured_output':'verified'})
        self.assertTrue(all(model['model_id']!='embed-only' for model in result['models']))
        posts=[call for call in self.server.calls if call[0]=='POST']
        self.assertTrue(any('responseFormat' in call[3]['generationConfig'] for call in posts))
        self.assertTrue(all('x-goog-api-key' not in call[3] for call in posts))

    def test_gemini_key_endpoint_and_secret_boundary(self):
        with self.assertRaises(ModelError) as error: self.registry.create('gemini')
        self.assertEqual(error.exception.code,'invalid_credential')
        with self.assertRaises(ModelError) as error:
            self.registry.create('gemini',base_url='https://example.com',secret=self.server.secret)
        self.assertEqual(error.exception.code,'invalid_endpoint')
        c=self.create(); result=self.registry.probe(c['id'])
        encoded=json.dumps({'connection':c,'result':result,'catalog':self.registry.catalog(c['id'])})
        self.assertNotIn(self.server.secret,encoded)
        diff=subprocess.run(['git','diff','HEAD'],capture_output=True,check=True).stdout
        self.assertNotIn(self.server.secret.encode(),diff)
        for path in Path(self.tmp.name).rglob('*'):
            if path.is_file(): self.assertNotIn(self.server.secret.encode(),path.read_bytes(),str(path))
        self.assertEqual(self.keys.get(c['credential_ref']),self.server.secret)
        self.assertEqual(self.server.calls[0],('GET','/v1beta/models?pageSize=1000'))

    def test_gemini_gui_api_never_returns_or_logs_key(self):
        from nidus.gui import GUIServer
        import logging
        import urllib.request
        from unittest.mock import patch
        gui=GUIServer(self.tmp.name,0); gui.credential_store=self.keys
        thread=threading.Thread(target=gui.serve_forever,daemon=True); thread.start()
        output=io.StringIO(); handler=logging.StreamHandler(output); logging.getLogger().addHandler(handler)
        def request(path,data=None):
            headers={'Origin':gui.origin,'X-Nidus-Token':gui.token,'Content-Type':'application/json'}
            req=urllib.request.Request(gui.origin+'/api/connections'+path,
                data=json.dumps(data).encode() if data is not None else None,headers=headers)
            with urllib.request.urlopen(req,timeout=10) as response: return json.load(response)
        providers=self.registry.providers.list()
        def make_registry(store,credentials=None):
            return ConnectionRegistry(store,credentials,providers=providers)
        try:
            with patch('nidus.gui.ConnectionRegistry',side_effect=make_registry):
                listing=request('')
                self.assertEqual([provider['id'] for provider in listing['providers']],
                    ['gemini','omniroute','openai-compatible'])
                created=request('',{'provider':'gemini','secret':self.server.secret})
                self.assertNotIn(self.server.secret,json.dumps(created))
                result=request('/'+created['id']+'/probe',{})
                self.assertEqual(result['connection']['status'],'ready')
                self.assertNotIn(self.server.secret,json.dumps(result))
        finally:
            logging.getLogger().removeHandler(handler)
            gui.shutdown(); gui.server_close(); thread.join()
        self.assertNotIn(self.server.secret,output.getvalue())
        self.assertNotIn(self.server.secret.encode(),self.store.db.execute('SELECT data FROM connections').fetchone()[0].encode())

    def test_auth_and_temporary_errors_map_to_blocked_or_degraded(self):
        for status,code,expected in [(401,'authentication_failed','blocked'),(403,'access_denied','blocked')]:
            self.server.discovery_status=status
            result=self.probe()['connection']
            self.assertEqual((result['status'],result['last_error']['code']),(expected,code))
        self.server.discovery_status=200
        for status,code in [(429,'rate_limited'),(503,'provider_unavailable'),(504,'timeout')]:
            self.server.generate_status[('gemini-a',False)]=status
            self.server.generate_status[('gemini-b',False)]=status
            result=self.probe()['connection']
            self.assertEqual(result['status'],'degraded')
            self.assertEqual(result['last_error']['code'],code)
            self.server.generate_status.clear()

    def test_gemini_rejects_credential_echoes_without_persisting_them(self):
        connection=self.create()
        self.server.models=[{'name':'models/'+self.server.secret,'supportedGenerationMethods':['generateContent']}]
        result=self.registry.probe(connection['id'])
        self.assertEqual(result['connection']['last_error']['code'],'credential_in_content')
        self.assertNotIn(self.server.secret,json.dumps(result))
        self.server.models=[{'name':'models/gemini-a','supportedGenerationMethods':['generateContent']}]
        self.server.outputs[('gemini-a',False)]=self.server.secret
        result=self.registry.probe(connection['id'])
        self.assertEqual(result['connection']['last_error']['code'],'credential_in_content')
        self.assertNotIn(self.server.secret,json.dumps(result))
        self.assertNotIn(self.server.secret.encode(),self.store.db.execute('SELECT data FROM connections').fetchone()[0].encode())

    def test_probe_candidate_limit_is_five(self):
        self.server.models=[{'name':'models/candidate-'+str(i),'supportedGenerationMethods':['generateContent']}
            for i in range(7)]
        for i in range(5): self.server.generate_status[('candidate-'+str(i),False)]=404
        result=self.probe(); posts=[call for call in self.server.calls if call[0]=='POST']
        self.assertEqual(result['connection']['status'],'blocked')
        self.assertEqual([call[1] for call in posts],['candidate-'+str(i) for i in range(5)])
        self.assertEqual(len(posts),5)

    def test_cached_gemini_candidates_keep_provider_order(self):
        self.server.models=[
            {'name':'models/gemini-b','supportedGenerationMethods':['generateContent']},
            {'name':'models/gemini-a','supportedGenerationMethods':['generateContent']},
        ]
        connection=self.create(); self.assertEqual(self.registry.probe(connection['id'])['connection']['status'],'ready')
        self.server.calls=[]; self.server.discovery_status=404
        self.server.generate_status[('gemini-b',False)]=400
        result=self.registry.probe(connection['id'])
        self.assertEqual(result['connection']['status'],'ready')
        self.assertEqual([call[1] for call in self.server.calls if call[0]=='POST'],
            ['gemini-b','gemini-a','gemini-a'])


if __name__=='__main__': unittest.main()


class ConnectionGUItests(unittest.TestCase):
    def setUp(self):
        from nidus.gui import GUIServer
        ConnectionTests.setUp(self)
        self.gui=GUIServer(self.tmp.name,0); self.gui.credential_store=self.keys
        self.gui_thread=threading.Thread(target=self.gui.serve_forever,daemon=True); self.gui_thread.start()
    def tearDown(self):
        self.gui.shutdown(); self.gui.server_close(); self.gui_thread.join(); ConnectionTests.tearDown(self)
    def request(self,path,data=None,trusted=True):
        import urllib.request
        headers={'Content-Type':'application/json'}
        if trusted: headers.update({'Origin':self.gui.origin,'X-Nidus-Token':self.gui.token})
        req=urllib.request.Request(self.gui.origin+'/api/connections'+path,
            data=json.dumps(data).encode() if data is not None else None,headers=headers)
        with urllib.request.urlopen(req,timeout=10) as response: return json.load(response)
    def test_gui_crud_probe_and_origin(self):
        import urllib.error
        providers=self.request('')['providers']
        self.assertEqual({p['id']:p['connection_kind'] for p in providers},
            {'gemini':'direct','omniroute':'gateway','openai-compatible':'compatible'})
        data={'provider':'openai-compatible','base_url':self.url,'secret':self.server.secret}
        with self.assertRaises(urllib.error.HTTPError) as error: self.request('',data,False)
        self.assertEqual(error.exception.code,403)
        c=self.request('',data); ident=c['id']
        self.assertNotIn(self.server.secret,json.dumps(c))
        self.assertEqual(self.request('/'+ident+'/probe',{})['connection']['status'],'ready')
        updated=self.request('/'+ident+'/update',{'secret':'updated-key'})
        self.assertEqual(updated['status'],'configured')
        self.assertEqual(self.request('')['connections'][0]['models'],[])
        self.request('/'+ident+'/delete',{}); self.assertEqual(self.request('')['connections'],[])

    def test_gui_creates_and_probes_omniroute_identity(self):
        data={'provider':'omniroute','base_url':self.url,'secret':self.server.secret}
        created=self.request('',data)
        self.assertEqual((created['provider'],created['connection_kind']),('omniroute','gateway'))
        result=self.request('/'+created['id']+'/probe',{})
        self.assertEqual(result['connection']['status'],'ready')
        self.assertEqual(result['connection']['provider'],'omniroute')
    def test_backend_diagnostics_never_reflected(self):
        import urllib.error
        with patch.object(self.keys,'put',side_effect=ValueError(self.server.secret)):
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.request('',{'provider':'openai-compatible','base_url':self.url,'secret':self.server.secret})
        self.assertNotIn(self.server.secret,error.exception.read().decode())
