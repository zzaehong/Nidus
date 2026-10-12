"""Persisted connection health and observed model capabilities, independent of tasks."""
import json
import time
import uuid
from .credentials import MacOSKeychainCredentialStore, EnvironmentCredentialProvider, validate_secret
from .gateway import ModelError, canonical, utc_now
from .providers import ProviderRegistry, OpenAICompatibleAdapter, endpoint


class ConnectionRegistry:
    def __init__(self, store, credentials=None, adapter=None):
        self.store=store
        self.credentials=credentials
        self.providers=ProviderRegistry()
        self.adapter=adapter or OpenAICompatibleAdapter()
        self.store.db.executescript('''
          CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS model_catalog (connection_id TEXT NOT NULL, model_id TEXT NOT NULL,
            data TEXT NOT NULL, PRIMARY KEY(connection_id, model_id));
        ''')
        # A process interrupted during a bounded probe never remains advertised as ready.
        with self.store.lock():
            for conn in self.list():
                if conn['status']=='probing':
                    conn['status']='degraded'; conn['last_error']=ModelError('probe_interrupted',True).metadata()
                    self._save(conn)

    def _backend(self, ref=None):
        if ref and ref.startswith('env:'): return EnvironmentCredentialProvider()
        if self.credentials is None: self.credentials=MacOSKeychainCredentialStore()
        return self.credentials

    def _save(self, conn):
        self.store.db.execute('INSERT OR REPLACE INTO connections VALUES (?,?)',(conn['id'],canonical(conn)))
        self.store.db.commit()

    def list(self):
        return [json.loads(r[0]) for r in self.store.db.execute('SELECT data FROM connections ORDER BY id')]

    def get(self, ident):
        row=self.store.db.execute('SELECT data FROM connections WHERE id=?',(ident,)).fetchone()
        if not row: raise ModelError('connection_missing')
        return json.loads(row[0])

    def catalog(self, ident):
        self.get(ident)
        return [json.loads(r[0]) for r in self.store.db.execute('SELECT data FROM model_catalog WHERE connection_id=? ORDER BY model_id',(ident,))]

    def list_ready_connections(self):
        return [c for c in self.list() if c['status']=='ready']

    def list_available_models(self, ident):
        return [m for m in self.catalog(ident) if m['availability']=='available']

    def _catalog_save(self, model):
        self.store.db.execute('INSERT OR REPLACE INTO model_catalog VALUES (?,?,?)',
            (model['connection_id'],model['model_id'],canonical(model)))
        self.store.db.commit()

    def create(self, provider, base_url, secret='', name='', credential_ref=None):
        manifest=self.providers.get(provider); base_url=endpoint(base_url or manifest['default_base_url'])
        validate_secret(secret)
        if not isinstance(name,str) or len(name)>128 or any(ord(c)<32 for c in name): raise ModelError('invalid_connection_name')
        ref=credential_ref or 'cred_'+uuid.uuid4().hex
        if credential_ref:
            if secret or not ref.startswith('env:'): raise ModelError('invalid_credential_reference')
            secret=self._backend(ref).get(ref)
        if secret and secret in base_url+name: raise ModelError('credential_in_content')
        with self.store.lock():
            if not credential_ref: self._backend().put(ref,secret)
            conn={'id':'conn_'+uuid.uuid4().hex,'provider':provider,'name':name or manifest['name'],
                'base_url':base_url,'credential_ref':ref,'status':'configured','created_at':utc_now(),
                'last_probe_at':None,'last_error':None,'discovery':{'supported':manifest['supports_model_discovery'],'status':'not_run'}}
            try: self._save(conn)
            except Exception:
                if not credential_ref: self._backend().delete(ref)
                raise
            return conn

    def update(self, ident, base_url=None, secret=None):
        with self.store.lock():
            conn=self.get(ident); ref=conn['credential_ref']
            if base_url is not None: base_url=endpoint(base_url)
            current=self._backend(ref).get(ref)
            if secret is not None: validate_secret(secret)
            if any(s and s in (base_url or conn['base_url'])+conn['name'] for s in (current,secret)):
                raise ModelError('credential_in_content')
            # Invalidate observations before changing the credential: failure cannot preserve ready.
            conn.update(status='configured',last_error=None,last_probe_at=None,
                        discovery={'supported':True,'status':'not_run'})
            if base_url is not None: conn['base_url']=base_url
            self._save(conn)
            self.store.db.execute('DELETE FROM model_catalog WHERE connection_id=?',(ident,)); self.store.db.commit()
            if secret is not None:
                if ref.startswith('env:'):
                    newref='cred_'+uuid.uuid4().hex; self._backend().put(newref,secret)
                    conn['credential_ref']=newref; self._save(conn)
                else: self._backend(ref).replace(ref,secret)
            return conn

    def delete(self, ident):
        with self.store.lock():
            conn=self.get(ident)
            conn['status']='blocked'; conn['last_error']=ModelError('connection_deleting').metadata(); self._save(conn)
            if not conn['credential_ref'].startswith('env:'): self._backend().delete(conn['credential_ref'])
            self.store.db.execute('DELETE FROM model_catalog WHERE connection_id=?',(ident,))
            self.store.db.execute('DELETE FROM connections WHERE id=?',(ident,)); self.store.db.commit()
        return {'deleted':ident}

    def select_probe_candidate(self, ident):
        return [m['model_id'] for m in self.catalog(ident)][:3]

    def probe(self, ident):
        with self.store.lock():
            conn=self.get(ident); endpoint(conn['base_url'])
            conn.update(status='probing',last_probe_at=utc_now(),last_error=None,probe={'generation':'not_run','structured_output':'not_run'})
            self._save(conn)
            try:
                secret=self._backend(conn['credential_ref']).get(conn['credential_ref']); validate_secret(secret)
                # Previously discovered IDs are the only fallback when discovery fails.
                old={m['model_id']:m for m in self.catalog(ident)}
                for m in old.values():
                    m.update(availability='unknown',capabilities={'chat':'unknown','structured_output':'unknown'})
                    self._catalog_save(m)
                try:
                    models=self.adapter.discover_models(conn,secret)
                    conn['discovery']={'supported':True,'status':'success','count':len(models)}
                except ModelError as error:
                    conn['discovery']={'supported':True,'status':'failed','error':error.metadata()}
                    if error.code in ('authentication_failed','access_denied','credential_in_content'): raise
                    models=list(old)
                for model in models:
                    if model not in old:
                        self._catalog_save({'connection_id':ident,'model_id':model,'discovered_at':utc_now(),
                            'availability':'unknown','capabilities':{'chat':'unknown','structured_output':'unknown'},
                            'last_probe_at':None,'last_success_at':None,'last_failure_at':None,'latency_ms':None,
                            'price':None,'context_length':None,'free_quota':None})
                if not models: raise ModelError('model_unavailable')
                last=ModelError('model_unavailable')
                for model in sorted(models)[:3]:
                    record=next(m for m in self.catalog(ident) if m['model_id']==model)
                    record['last_probe_at']=utc_now(); start=time.monotonic()
                    try:
                        result=self.adapter.generate(conn,model,secret)
                        if result['text'].strip()!='READY': raise ModelError('acceptance_failed')
                        record.update(availability='available',last_success_at=utc_now(),last_error=None,
                            latency_ms=round((time.monotonic()-start)*1000),actual_model=result['model'],tokens=result['tokens'])
                        record['capabilities']['chat']='verified'
                        conn['probe']['generation']='passed'
                        try:
                            structured=self.adapter.generate(conn,model,secret,structured=True)
                            try: passed=json.loads(structured['text'])=={'status':'READY'}
                            except (ValueError,TypeError): passed=False
                            if not passed: raise ModelError('structured_output_unsupported')
                            record['capabilities']['structured_output']='verified'
                            conn['probe']['structured_output']='passed'
                        except ModelError as error:
                            record['capabilities']['structured_output']='unverified'
                            record['structured_error']=error.metadata(); record['last_failure_at']=utc_now()
                            conn['probe']['structured_output']='failed'
                            if error.code in ('authentication_failed','access_denied','credential_in_content'): raise
                        self._catalog_save(record)
                        conn['status']='ready' if record['capabilities']['structured_output']=='verified' else 'degraded'
                        conn['last_error']=record.get('structured_error') if conn['status']=='degraded' else None
                        break
                    except ModelError as error:
                        last=error
                        record.update(availability=error.code if error.code in ('rate_limited','authentication_failed') else
                            ('temporarily_unavailable' if error.retryable else 'unsupported'),last_failure_at=utc_now(),last_error=error.metadata())
                        self._catalog_save(record)
                        if error.code in ('authentication_failed','access_denied','credential_in_content','rate_limited','quota_exhausted'): raise
                else: raise last
            except ModelError as error:
                conn['status']='degraded' if error.retryable or error.code=='model_unavailable' else 'blocked'
                conn['last_error']=error.metadata()
            self._save(conn)
            return {'connection':conn,'models':self.catalog(ident)}
