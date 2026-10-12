"""Explicit, bounded public synthetic connection probe. Never reads Vault content."""
import argparse
import json
import os
from pathlib import Path
import socket
import tempfile
import urllib.parse
from nidus.connections import ConnectionRegistry
from nidus.gateway import utc_now, ModelError
from nidus.providers import endpoint
from nidus.store import Store


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--allow-synthetic-transmission',action='store_true',required=True)
    parser.add_argument('--endpoint',default='http://127.0.0.1:20128/v1')
    parser.add_argument('--credential-env-file')
    parser.add_argument('--credential-env',default='NIDUS_POOL_API_KEY')
    parser.add_argument('--evidence',required=True)
    args=parser.parse_args(); destination=Path(args.evidence)
    if destination.exists(): parser.error('Evidence exists; use a new path')
    url=endpoint(args.endpoint); parsed=urllib.parse.urlsplit(url)
    if parsed.hostname not in ('127.0.0.1','localhost','::1'): parser.error('This live harness is local OmniRoute only')
    if args.credential_env_file:
        for line in Path(args.credential_env_file).expanduser().read_text().splitlines():
            key,sep,value=line.strip().removeprefix('export ').partition('=')
            if sep and key==args.credential_env: os.environ[key]=value.strip().strip('\"\'')
    evidence={'timestamp':utc_now(),'connection_type':'omniroute','endpoint_host':parsed.hostname,
        'synthetic_only':True,'status':'NOT RUN','reason':None}
    if args.credential_env not in os.environ:
        evidence['reason']='credential_not_available'
    else:
        try:
            with socket.create_connection((parsed.hostname,parsed.port or 80),timeout=2): pass
        except OSError:
            evidence['reason']='endpoint_not_running'
        else:
            with tempfile.TemporaryDirectory(prefix='nidus-connection-live-') as vault:
                store=Store(vault)
                try:
                    registry=ConnectionRegistry(store)
                    conn=registry.create('omniroute',url,credential_ref='env:'+args.credential_env)
                    result=registry.probe(conn['id']); connection=result['connection']
                    evidence.update(status='PASS' if connection['status']=='ready' else 'FAILED',
                        connection_status=connection['status'],discovery=connection['discovery'],
                        probe=connection['probe'],error=connection['last_error'],
                        models=[{k:m.get(k) for k in ('model_id','actual_model','availability','capabilities','latency_ms','tokens','last_error','structured_error','last_probe_at')}
                            for m in result['models'] if m['last_probe_at']])
                except ModelError as error:
                    evidence.update(status='FAILED',error=error.metadata())
                finally: store.close()
    raw=json.dumps(evidence,ensure_ascii=False,indent=2)+'\n'
    secret=os.environ.get(args.credential_env)
    if secret and secret in raw: raise ModelError('credential_in_content')
    destination.write_text(raw)
    print(json.dumps({'status':evidence['status'],'reason':evidence['reason'],'evidence':str(destination)}))


if __name__=='__main__': main()
