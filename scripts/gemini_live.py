"""Optional synthetic-only live probe for the native Gemini Connection."""
import argparse
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from nidus.connections import ConnectionRegistry
from nidus.gateway import ModelError, utc_now
from nidus.testing import temporary_vault
from nidus.store import Store


def read_credential_file(path, env_name):
    for line in Path(path).expanduser().read_text(encoding='utf-8').splitlines():
        key, separator, value=line.strip().removeprefix('export ').partition('=')
        if separator and key==env_name:
            os.environ[env_name]=value.strip().strip('"\'')
            return


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--allow-synthetic-transmission',action='store_true',required=True)
    parser.add_argument('--credential-env-file')
    parser.add_argument('--credential-env',default='NIDUS_GEMINI_API_KEY')
    parser.add_argument('--evidence',required=True)
    args=parser.parse_args(); destination=Path(args.evidence)
    if destination.exists(): parser.error('Evidence exists; use a new path')
    evidence={'timestamp':utc_now(),'provider':'gemini','synthetic_only':True,'status':'NOT RUN',
        'reason':None,'discovered_generation_models':None,'selected_model':None,
        'normal_generation':'NOT RUN','structured_generation':'NOT RUN','actual_model':None,
        'latency_ms':None,'token_metadata':None}
    if args.credential_env_file:
        read_credential_file(args.credential_env_file,args.credential_env)
    secret=os.environ.get(args.credential_env)
    if not secret:
        evidence['reason']='credential_not_available'
    else:
        with temporary_vault(prefix='nidus-gemini-live-') as vault:
            store=Store(vault)
            try:
                registry=ConnectionRegistry(store)
                connection=registry.create('gemini',credential_ref='env:'+args.credential_env)
                result=registry.probe(connection['id']); checked=result['connection']
                models=[model for model in result['models'] if model.get('last_probe_at')]
                selected=next((model for model in models if model['capabilities'].get('structured_output')=='verified'),None)
                evidence.update(status='PASS' if checked['status']=='ready' else 'FAILED',
                    connection_status=checked['status'],discovery=checked.get('discovery'),
                    discovered_generation_models=checked.get('discovery',{}).get('count'),
                    selected_model=selected.get('model_id') if selected else None,
                    normal_generation='PASS' if selected and selected['capabilities'].get('chat')=='verified' else 'FAILED',
                    structured_generation='PASS' if selected else 'FAILED',
                    actual_model=selected.get('actual_model') if selected else None,
                    latency_ms=selected.get('latency_ms') if selected else None,
                    token_metadata=selected.get('tokens') if selected else None,
                    probe=checked.get('probe'),error=checked.get('last_error'))
            except ModelError as error:
                evidence.update(status='FAILED',error=error.metadata())
            finally:
                store.close()
    raw=json.dumps(evidence,ensure_ascii=False,indent=2)+'\n'
    if secret and secret in raw: raise ModelError('credential_in_content')
    destination.parent.mkdir(parents=True,exist_ok=True)
    with destination.open('x',encoding='utf-8') as output: output.write(raw)
    print(json.dumps({'status':evidence['status'],'reason':evidence['reason'],'evidence':str(destination)}))


if __name__=='__main__': main()
