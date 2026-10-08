"""Run the real CLI in separate processes using an isolated temporary vault."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path


def main():
    vault = Path(tempfile.mkdtemp(prefix='nidus-demo-'))
    (vault / 'notes.md').write_text('# Meeting notes\nShip the local runtime.\nVerify before completion.\n', encoding='utf-8')

    def cli(*args):
        result = subprocess.run([sys.executable, '-m', 'nidus', '--vault', str(vault), *args],
                                check=True, capture_output=True, text=True)
        return json.loads(result.stdout)

    cli('init')
    task = cli('submit', 'Create an evidence briefing of the meeting notes',
               '--source', 'notes.md', '--output', 'results/brief.md')
    assert cli('run', task['id'], '--execute-only')['status'] == 'verifying'
    completed = cli('run', task['id'])
    assert completed['status'] == 'completed'
    assert cli('list') == []
    assert cli('list', '--archive')[0]['id'] == task['id']
    print(json.dumps({'vault': str(vault), 'task': task['id'],
        'status': completed['status'], 'verification': completed['verification'],
        'output': str(vault / task['output'])}, indent=2))


if __name__ == '__main__':
    main()
