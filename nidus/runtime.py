import hashlib
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_path(vault, name):
    relative = Path(name)
    if not name or relative.is_absolute() or '..' in relative.parts:
        raise ValueError('Denied path: ' + name)
    if relative.suffix.lower() not in ('.md', '.txt'):
        raise ValueError('Only .md and .txt resources are allowed')
    cursor = vault
    for part in relative.parts:
        if part.startswith('.'):
            raise ValueError('Hidden/system resources are denied')
        cursor = cursor / part
        if cursor.is_symlink():
            raise ValueError('Symlink resources are denied')
    if cursor.exists() and not cursor.is_file():
        raise ValueError('Resource must be a regular file')
    return cursor


def sources_for(store, task):
    records = []
    for name in task['sources']:
        path = safe_path(store.vault, name)
        with path.open('rb') as stream:
            data = stream.read(1024 * 1024 + 1)
        if len(data) > 1024 * 1024:
            raise ValueError('Source exceeds 1 MiB limit')
        records.append({'path': name, 'hash': digest(data), 'text': data.decode('utf-8')})
    return records


def briefing(task, records):
    lines = ['# Nidus evidence briefing', '', 'Mode: deterministic extraction (not semantic summarization).',
             '', '## Work request', task['request'], '']
    for record in records:
        lines += ['## Source: ' + record['path'], 'SHA-256: ' + record['hash'], '']
        lines += [line for line in record['text'].splitlines() if line.strip()][:3]
        lines.append('')
    return ('\n'.join(lines) + '\n').encode('utf-8')


class Runtime:
    def __init__(self, store):
        self.store = store

    def run(self, task_id, execute_only=False):
        with self.store.lock():
            task = self.store.get(task_id)
            if task['status'] in ('completed', 'cancelled', 'waiting'):
                return task
            try:
                if task['status'] != 'verifying':
                    task['status'] = 'running'
                    self.store.save(task, 'claimed')
                    records = sources_for(self.store, task)
                    output = safe_path(self.store.vault, task['output'])
                    if output in [safe_path(self.store.vault, name) for name in task['sources']]:
                        raise ValueError('Output cannot replace a source')
                    if output.exists():
                        raise ValueError('Existing output requires approval (not enabled in this slice)')
                    output.parent.mkdir(parents=True, exist_ok=True)
                    expected = briefing(task, records)
                    with output.open('xb') as stream:
                        stream.write(expected)
                    task['source_hashes'] = {r['path']: r['hash'] for r in records}
                    task['status'] = 'verifying'
                    task['candidate_hash'] = digest(expected)
                    self.store.save(task, 'candidate_written')
                    if execute_only:
                        return task
                records = sources_for(self.store, task)
                expected = briefing(task, records)
                output = safe_path(self.store.vault, task['output']).read_bytes()
                checks = {'sources_unchanged': task['source_hashes'] == {r['path']: r['hash'] for r in records},
                          'output_matches': output == expected,
                          'candidate_matches': digest(output) == task['candidate_hash']}
                task['verification'] = checks
                if not all(checks.values()):
                    raise ValueError('Verification failed')
                task['status'] = 'completed'
                task['contract']['result'] = {'output': task['output'], 'sha256': digest(output),
                    'verification': checks, 'limitations': ['Deterministic extraction only']}
                self.store.save(task, 'verified_completed')
            except (OSError, ValueError) as error:
                task['status'] = 'blocked'
                task['error'] = str(error)
                self.store.save(task, 'blocked', {'reason': str(error)})
            return task
