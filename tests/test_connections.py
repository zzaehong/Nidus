import contextlib
import io
import json
import logging
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest.mock import patch
from nidus.connections import ConnectionRegistry
from nidus.credentials import EnvironmentCredentialProvider, validate_secret
from nidus.gateway import ModelError
from nidus.providers import ProviderRegistry, endpoint
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


class ConnectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.store=Store(self.tmp.name); self.keys=MemoryCredentials()
        self.registry=ConnectionRegistry(self.store,self.keys)
        self.server=HTTPServer(('127.0.0.1',0),FakeProvider)
        self.server.discovery=200; self.server.generation=200; self.server.structured=200
        self.server.model='synthetic-model'; self.server.output='{"status":"READY"}'; self.server.plain='READY'
        self.server.secret='test-secret-7abf13b'; self.server.calls=[]
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True); self.thread.start()
        self.url='http://127.0.0.1:'+str(self.server.server_port)+'/v1'
    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(); self.store.close(); self.tmp.cleanup()
    def create(self): return self.registry.create('omniroute',self.url,self.server.secret)
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
        self.registry.delete(c['id']); self.assertFalse(self.keys.exists(c['credential_ref']))
        with self.assertRaises(ModelError): self.registry.get(c['id'])
        with self.assertRaises(ModelError): self.keys.get(c['credential_ref'])

    def test_auth_no_fallback(self):
        self.server.generation=401; r=self.probe()
        self.assertEqual(r['connection']['status'],'blocked')
        self.assertEqual(r['connection']['last_error']['code'],'authentication_failed')
        self.assertEqual(len(self.server.calls),2)
        self.server.calls=[]; self.server.discovery=401; self.probe(); self.assertEqual(len(self.server.calls),1)

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
        with self.assertRaises(ModelError): self.registry.create('omniroute',self.url+'/'+self.server.secret,self.server.secret)

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

    def test_manifest_and_endpoints(self):
        manifests=ProviderRegistry().list(); self.assertEqual(len(manifests),2)
        for values in [manifests+[manifests[0]], [dict(manifests[0],auth_type='oauth')], [dict(manifests[0],protocol='native')]]:
            with self.assertRaises(ModelError): ProviderRegistry(values)
        for url in ['http://example.com/v1','https://a:b@example.com/v1','https://example.com/v1?q=a',
                    'https://example.com/#x','http://[invalid','https://example.com:bad','https://example.com/\n']:
            with self.assertRaises(ModelError): endpoint(url)
        self.assertEqual(endpoint('https://example.com/v1/'),'https://example.com/v1')


if __name__=='__main__': unittest.main()
