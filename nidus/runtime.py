import hashlib
import os
import tempfile
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


def output_hash(path):
    if not path.exists():
        return None
    with path.open('rb') as stream:
        data = stream.read(32 * 1024 * 1024 + 1)
    if len(data) > 32 * 1024 * 1024:
        raise ValueError('Output exceeds 32 MiB limit')
    return digest(data)


class Runtime:
    def __init__(self, store):
        self.store = store

    def checkpoint(self, task, next_action):
        home = self.store.state('home')
        home['task'] = None if task['status'] in ('completed', 'cancelled') else task['id']
        self.store.set_state('home', home)
        previous = self.store.state('desk:' + task['id']) or {}
        desk = {'task': task['id'], 'board_status': task['status'],
                'library': task['sources'], 'next_action': next_action,
                'native_notes': previous.get('native_notes', [])}
        self.store.set_state('desk:' + task['id'], desk)
        self.store.save(task, 'desk_checkpoint', desk)

    def recover(self, task):
        home = self.store.state('home')
        desk = self.store.state('desk:' + task['id']) or {}
        if home['employee'] != task['employee']:
            raise ValueError('Employee identity does not match assignment')
        records = sources_for(self.store, task)
        self.store.save(task, 'context_recovered', {'order': ['home', 'desk', 'task_board', 'library'],
            'previous_reference': desk.get('board_status'), 'board_status': task['status'],
            'sources': {r['path']: r['hash'] for r in records}})
        self.checkpoint(task, 'verify' if task['status'] == 'verifying' else 'execute')
        return records

    def decide(self, task_id, decision):
        with self.store.lock():
            task = self.store.get(task_id)
            if task['status'] != 'waiting' or decision not in ('approve', 'reject'):
                raise ValueError('Decision requires a Waiting task and approve/reject')
            task['decisions'].append({'decision': decision, 'snapshot': task['attention']['snapshot']})
            task['status'] = 'queued' if decision == 'approve' else 'cancelled'
            self.store.save(task, 'human_decision', task['decisions'][-1])
            self.checkpoint(task, 'recover' if decision == 'approve' else 'none')
            return task

    def execute(self, task, records):
        output = safe_path(self.store.vault, task['output'])
        if output in [safe_path(self.store.vault, name) for name in task['sources']]:
            raise ValueError('Output cannot replace a source')
        source_hashes = {r['path']: r['hash'] for r in records}
        expected = briefing(task, records)
        current = output_hash(output)
        snapshot = {'sources': source_hashes, 'output': task['output'], 'output_hash': current}
        intent = task.get('write_intent')
        # Recover a crash after write but before candidate DB transition. Only our
        # recorded intent, source snapshot and exact bytes establish ownership.
        recovered = (intent and intent['sources'] == source_hashes
                     and intent['expected_hash'] == digest(expected) and current == digest(expected))
        if current is not None and not recovered:
            approved = any(d['decision'] == 'approve' and d['snapshot'] == snapshot for d in task['decisions'])
            if not approved:
                task['status'] = 'waiting'
                task['attention'] = {'subject': 'Replace existing output?',
                    'background': 'A file already exists at ' + task['output'],
                    'reason': 'Replacing user content requires an exact scoped decision',
                    'choices': {'approve': 'Replace only this file at the reviewed snapshot',
                                'reject': 'Cancel task and preserve existing content'}, 'snapshot': snapshot}
                self.store.save(task, 'permission_ask', task['attention'])
                self.checkpoint(task, 'await_human')
                return False
        self.store.save(task, 'permission_allow', {'employee': task['employee'],
            'resource': task['output'], 'action': 'write', 'risk': 'scoped-local', 'snapshot': snapshot})
        if not recovered:
            task['write_intent'] = {'sources': source_hashes, 'expected_hash': digest(expected)}
            self.store.save(task, 'write_intent')
            # Recheck source and destination snapshots immediately before execution.
            latest = sources_for(self.store, task)
            if source_hashes != {r['path']: r['hash'] for r in latest} or output_hash(output) != current:
                raise ValueError('Resources changed before execution; retry to review current snapshot')
            safe_path(self.store.vault, task['output'])
            # Preserve the reviewed preimage before any approved replacement.
            if self.store.versioning:
                resources = list(task['sources'])
                if current is not None:
                    resources.append(task['output'])
                self.store.versioning.checkpoint(resources)
            output.parent.mkdir(parents=True, exist_ok=True)
            if current is None:
                with output.open('xb') as stream:
                    stream.write(expected)
                    stream.flush()
                    os.fsync(stream.fileno())
            else:
                fd, temporary = tempfile.mkstemp(prefix='nidus-', dir=str(output.parent))
                try:
                    with os.fdopen(fd, 'wb') as stream:
                        stream.write(expected)
                        stream.flush()
                        os.fsync(stream.fileno())
                    os.replace(temporary, output)
                finally:
                    if os.path.exists(temporary):
                        os.unlink(temporary)
        task['source_hashes'] = source_hashes
        task['status'] = 'verifying'
        task['candidate_hash'] = digest(expected)
        self.store.save(task, 'candidate_written', {'recovered_write': bool(recovered)})
        self.checkpoint(task, 'verify')
        return True

    def run(self, task_id, execute_only=False):
        with self.store.lock():
            task = self.store.get(task_id)
            if task['status'] in ('completed', 'cancelled', 'waiting'):
                return task
            try:
                records = self.recover(task)
                if task['status'] != 'verifying':
                    task['status'] = 'running'
                    task.pop('error', None)
                    self.store.save(task, 'claimed')
                    if not self.execute(task, records):
                        return task
                    if execute_only:
                        return task
                records = sources_for(self.store, task)
                expected = briefing(task, records)
                output_path = safe_path(self.store.vault, task['output'])
                if output_hash(output_path) is None:
                    raise ValueError('Candidate output missing')
                output = output_path.read_bytes()
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
                self.checkpoint(task, 'none')
            except (OSError, ValueError) as error:
                task['status'] = 'blocked'
                task['error'] = str(error)
                self.store.save(task, 'blocked', {'reason': str(error)})
                self.checkpoint(task, 'review_blocker')
            return task
