"""Opt-in Manager/Worker acceptance on public synthetic data, never personal files."""
import argparse
import datetime
import json
import subprocess
import sys
import tempfile
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--allow-synthetic-transmission', action='store_true', required=True)
    parser.add_argument('--policy', default='model-policy.pool.example.json')
    parser.add_argument('--manager-policy')
    parser.add_argument('--evidence', required=True)
    args = parser.parse_args()
    destination = Path(args.evidence)
    if destination.exists():
        parser.error('Evidence already exists; choose a new path')
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    vault = Path(tempfile.mkdtemp(prefix='nidus-workflow-live-'))
    source = ('# Public synthetic Nidus example\n'
              'Nidus stores task state in a local vault.\n'
              'Nidus retains completed task history in an archive.\n'
              'Replacing an existing output file requires human approval.\n')
    (vault / 'notes.md').write_text(source, encoding='utf-8')
    calls = []

    def cli(*arguments):
        result = subprocess.run([sys.executable, '-m','nidus','--vault',str(vault),*arguments],
                                capture_output=True, text=True)
        calls.append({'command':arguments[0], 'exit_code':result.returncode})
        try:
            return json.loads(result.stdout)
        except ValueError:
            return {'status':'blocked', 'error':'CLI did not return task JSON'}

    request = ('Summarize the supplied public synthetic Nidus example in exactly three concise bullet points. '
               'Include the literal phrase Nidus and use only the supplied facts.')
    options = ['--manager-policy',args.manager_policy] if args.manager_policy else []
    task = cli('submit',request,'--source','notes.md','--output','results/summary.md',
               '--mode','generative','--model-policy',args.policy,'--max-reworks','1','--require','Nidus',*options)
    if 'id' not in task:
        print(json.dumps(task))
        return 2
    result = task
    # This flag approves only the exact synthetic prompts selected by this
    # harness. It never provides a human quality judgment or broad permission.
    for _ in range(12):
        result = cli('run',task['id'])
        if result['status'] == 'waiting':
            if result['attention'].get('kind') == 'quality':
                break
            if result['attention']['snapshot'].get('action') != 'model_transmission':
                break
            cli('decide',task['id'],'approve')
        elif result['status'] != 'queued':
            break
    inspected = cli('show',task['id'])
    evidence = {'started_at':started, 'finished_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'scope':'real model calls on public synthetic data; exact transmission approval only',
        'source':source, 'request':request, 'vault':str(vault), 'status':result['status'],
        'task':inspected, 'cli':calls, 'active_count':len(cli('list')), 'archive_count':len(cli('list','--archive'))}
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open('x',encoding='utf-8') as stream:
        json.dump(evidence,stream,ensure_ascii=False,indent=2)
        stream.write('\n')
    print(json.dumps({'status':evidence['status'], 'evidence':str(destination),
        'verification':inspected.get('verification'), 'manager_decision':inspected.get('manager_review',{}).get('decision'),
        'model_error':inspected.get('model_error'), 'active_count':evidence['active_count'],
        'archive_count':evidence['archive_count']},ensure_ascii=False,indent=2))
    return 0 if result['status'] == 'completed' else 2


if __name__ == '__main__':
    sys.exit(main())
