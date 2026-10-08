"""Explicit live acceptance, synthetic data only. Not part of offline tests."""
import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--allow-synthetic-transmission', action='store_true', required=True)
    parser.add_argument('--policy', default='model-policy.example.json')
    parser.add_argument('--evidence', default='docs/evidence/model-live.json')
    args = parser.parse_args()
    vault = Path(tempfile.mkdtemp(prefix='nidus-model-live-'))
    (vault / 'notes.md').write_text('# Nidus sample\nNidus stores task state in a local vault.\n'
        'A task completes only after verification passes.\n'
        'Existing output files require human approval before replacement.\n', encoding='utf-8')
    calls = []

    def cli(*arguments):
        result = subprocess.run([sys.executable, '-m', 'nidus', '--vault', str(vault), *arguments],
            capture_output=True, text=True)
        # Runtime errors contain safe codes; never print environment or HTTP headers.
        try:
            value = json.loads(result.stdout)
        except ValueError:
            value = {'status': 'blocked', 'error': 'CLI could not return task JSON'}
        calls.append({'command': list(arguments[:1]), 'exit_code': result.returncode})
        return value

    cli('init')
    task = cli('submit', 'Summarize the supplied Nidus sample in exactly three concise bullet points. '
        'Include the literal phrase Nidus. Use only the supplied facts.', '--source', 'notes.md',
        '--output', 'results/summary.md', '--mode', 'generative', '--model-policy', args.policy,
        '--require', 'Nidus')
    if 'id' not in task:
        print(json.dumps({'status': 'blocked', 'error': task.get('error')}, indent=2))
        return 2
    waiting = cli('run', task['id'])
    if waiting.get('status') == 'waiting' and waiting['attention']['snapshot'].get('action') == 'model_transmission':
        cli('decide', task['id'], 'approve')
        result = cli('run', task['id'])
    else:
        result = waiting
    inspected = cli('show', task['id'])
    evidence = {'status': result.get('status'), 'vault': str(vault), 'task': task['id'],
        'source': (vault / 'notes.md').read_text(encoding='utf-8'), 'request': task['request'],
        'verification': inspected.get('verification'), 'model_error': inspected.get('model_error'),
        'result': inspected['contract']['result'], 'generation': inspected.get('generation'),
        'model_events': [e for e in inspected['history'] if e['kind'].startswith('model_')], 'cli': calls,
        'active_count': len(cli('list')), 'archive_count': len(cli('list', '--archive'))}
    destination = Path(args.evidence)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': evidence['status'], 'evidence': str(destination), 'vault': str(vault),
        'verification': evidence['verification'], 'model_error': evidence['model_error']}, ensure_ascii=False, indent=2))
    return 0 if result.get('status') == 'completed' else 2


if __name__ == '__main__':
    sys.exit(main())
