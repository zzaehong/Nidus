"""Opt-in bounded real-model multi-task acceptance using public synthetic data only."""
import argparse
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from nidus.testing import persistent_vault


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--allow-synthetic-transmission', action='store_true', required=True)
    parser.add_argument('--policy', required=True)
    parser.add_argument('--credential-env-file', help='Load existing key assignments into memory; never log values')
    parser.add_argument('--evidence', required=True)
    args = parser.parse_args()
    destination = Path(args.evidence)
    if destination.exists():
        parser.error('Evidence exists; use a new path')
    if args.credential_env_file:
        # Inert KEY=value only; never execute a shell or print file contents.
        for line in Path(args.credential_env_file).expanduser().read_text().splitlines():
            line = line.strip()
            if line.startswith('export '): line = line[7:]
            if not line or line.startswith('#'): continue
            key, separator, value = line.partition('=')
            if separator and key.startswith('NIDUS_') and key.endswith('_API_KEY'):
                os.environ[key] = value.strip().strip('\"\'')
    started = datetime.now(timezone.utc).isoformat()
    code_hashes = {str(p):hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(Path('nidus').rglob('*.py'))}
    revision = subprocess.run(['git','rev-parse','HEAD'],capture_output=True,text=True).stdout.strip()
    vault = persistent_vault(prefix='nidus-plan-live-')
    source = ('# Public synthetic Nidus facts\n'
        'Nidus stores task state locally in a vault.\n'
        'Completed tasks retain their approved result and review history.\n'
        'External model transmissions require exact scoped human approval.\n'
        'A Manager reviews Worker submissions before task completion.\n')
    (vault/'facts.md').write_text(source,encoding='utf-8')
    request = ('Write a concise source-grounded Nidus report with exactly four bullet points covering '
        'local task storage, retained completion history, scoped model-transmission approval and Manager review. '
        'Use only the four supplied facts without adding claims, significance or recommendations. '
        'First assemble a factual evidence note, then compose the report using the approved note. '
        'Use exactly two dependent Tasks with unique output paths. Task criteria assess document content only; '
        'artifact persistence is Runtime responsibility, not a Worker action.')
    calls = []
    def cli(*arguments):
        result = subprocess.run([sys.executable,'-m','nidus','--vault',str(vault),*arguments],
                                capture_output=True,text=True,timeout=180)
        calls.append({'command':arguments[0],'exit_code':result.returncode})
        try: return json.loads(result.stdout)
        except ValueError: return {'status':'blocked','error':'CLI returned no JSON'}
    plan = cli('plan-submit',request,'--source','facts.md','--model-policy',args.policy)
    current = plan
    if 'id' in plan:
        for _ in range(60):
            current = cli('plan-run',plan['id'])
            if current.get('status') in ('completed','blocked','cancelled'): break
            if current.get('status') == 'waiting':
                attention = current.get('attention',{})
                if attention.get('kind') != 'transmission': break
                cli('plan-decide',plan['id'],'approve')
            stopped = False
            for tid in current.get('tasks',[]):
                task = cli('show',tid)
                if task['status'] == 'waiting':
                    if task['attention'].get('kind') == 'quality': stopped = True; break
                    if task['attention']['snapshot'].get('action') != 'model_transmission': stopped = True; break
                    cli('decide',tid,'approve')
            if stopped: break
        inspected = cli('plan-show',plan['id'])
        tasks = [cli('show',tid) for tid in inspected.get('tasks',[])]
    else:
        inspected, tasks = current, []
    evidence = {'started_at':started,'finished_at':datetime.now(timezone.utc).isoformat(),
        'code_revision':revision,'code_sha256':code_hashes,
        'scope':'Real external model calls; public synthetic data; exact transmissions only; no quality overrides',
        'original_request':request,'source':source,'vault':str(vault),'status':current.get('status'),
        'plan':inspected,'tasks':tasks,'cli':calls,
        'code_unchanged':code_hashes == {str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(Path('nidus').rglob('*.py'))},
        'archive_count':len(cli('plan-list','--archive')),'task_archive_count':len(cli('list','--archive'))}
    raw = json.dumps(evidence,ensure_ascii=False,indent=2)+'\n'
    from nidus.gateway import reject_credentials, load_policy
    reject_credentials(raw,load_policy(args.policy))
    destination.parent.mkdir(parents=True,exist_ok=True)
    with destination.open('x',encoding='utf-8') as stream: stream.write(raw)
    print(json.dumps({'status':evidence['status'],'evidence':str(destination),
        'plan_id':inspected.get('id'),'tasks':len(tasks),'archive_count':evidence['archive_count'],
        'error':inspected.get('error')},ensure_ascii=False))
    return 0 if evidence['status'] == 'completed' and len(tasks) >= 2 else 2


if __name__ == '__main__':
    sys.exit(main())
