import contextlib
import fcntl
import json
import sqlite3
import uuid
from pathlib import Path
from .versioning import VaultGit


class Store:
    def __init__(self, vault):
        self.vault = Path(vault).resolve()
        self.system = self.vault / '.nidus'
        if self.system.is_symlink():
            raise ValueError('System directory must not be a symlink')
        self.system.mkdir(parents=True, exist_ok=True)
        for name in ('state.sqlite3', 'runtime.lock', '.gitignore'):
            if (self.system / name).is_symlink():
                raise ValueError('System files must not be symlinks')
        self.versioning = None
        with self.lock():
            ignore = self.system / '.gitignore'
            if not ignore.exists():
                ignore.write_text('runtime.lock\nstate.sqlite3-journal\n', encoding='utf-8')
            self.db = sqlite3.connect(str(self.system / 'state.sqlite3'))
            self.db.row_factory = sqlite3.Row
            version = self.db.execute('PRAGMA user_version').fetchone()[0]
            if version not in (0, 1):
                raise ValueError('Unsupported vault schema')
            self.db.executescript('''
                CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, task TEXT, kind TEXT, data TEXT);
                CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, data TEXT NOT NULL);
                PRAGMA user_version=1;
            ''')
            self.db.commit()
            if self.state('home') is None:
                self.set_state('home', {'employee': 'worker-1', 'group': 'Operations',
                    'role': 'document analyst', 'principles': ['Protect originals', 'Verify before completion'],
                    'task': None})
            self.versioning = VaultGit(self.vault)
            self.versioning.checkpoint([])

    def close(self):
        self.db.close()

    @contextlib.contextmanager
    def lock(self):
        with (self.system / 'runtime.lock').open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ValueError('Another runtime owns this vault')
            try:
                before = self.db.execute('SELECT COALESCE(MAX(seq),0) FROM events').fetchone()[0] if self.versioning else 0
                yield
                if self.versioning:
                    from .runtime import safe_path
                    resources = []
                    rows = self.db.execute("SELECT DISTINCT task FROM events WHERE seq>? AND kind IN ('candidate_written','verified_completed')", (before,))
                    for row in rows:
                        task = self.get(row[0])
                        output = safe_path(self.vault, task['output'])
                        if output.exists():
                            resources.append(task['output'])
                        for name in task['sources']:
                            if safe_path(self.vault, name).exists():
                                resources.append(name)
                    try:
                        self.versioning.checkpoint(resources)
                    except ValueError as error:
                        # Do not leave an unversioned task advertised as success.
                        affected = list(self.db.execute('SELECT DISTINCT task FROM events WHERE seq>?', (before,)))
                        for row in affected:
                            task = self.get(row[0])
                            task['status'] = 'blocked'
                            task['error'] = str(error)
                            task['contract']['result'] = None
                            self.save(task, 'versioning_failed', {'reason': str(error)})
                            home = self.state('home')
                            home['task'] = task['id']
                            self.set_state('home', home)
                        raise
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)

    def state(self, key):
        row = self.db.execute('SELECT data FROM state WHERE key=?', (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def set_state(self, key, value):
        self.db.execute('INSERT OR REPLACE INTO state VALUES (?,?)', (key, json.dumps(value)))
        self.db.commit()

    def save(self, task, kind, detail=None):
        with self.db:
            self.db.execute('INSERT OR REPLACE INTO tasks VALUES (?,?)', (task['id'], json.dumps(task)))
            self.db.execute('INSERT INTO events(task,kind,data) VALUES (?,?,?)',
                (task['id'], kind, json.dumps(detail if detail is not None else {'status': task['status']})))

    def get(self, task_id):
        row = self.db.execute('SELECT data FROM tasks WHERE id=?', (task_id,)).fetchone()
        if not row:
            raise ValueError('Unknown task: ' + task_id)
        return json.loads(row[0])

    def tasks(self, archive=False):
        tasks = [json.loads(row[0]) for row in self.db.execute('SELECT data FROM tasks ORDER BY rowid')]
        return [t for t in tasks if (t['status'] == 'completed') == archive]

    def events(self, task_id):
        return [dict(row, data=json.loads(row['data'])) for row in self.db.execute(
            'SELECT seq,kind,data FROM events WHERE task=? ORDER BY seq', (task_id,))]

    def submit(self, request, sources, output, priority):
        if not request.strip() or not 1 <= len(sources) <= 20 or len(set(sources)) != len(sources):
            raise ValueError('Provide a nonempty request and 1–20 unique sources')
        task = {'id': uuid.uuid4().hex, 'request': request, 'sources': sources,
                'output': output, 'priority': priority, 'employee': 'worker-1', 'status': 'queued',
                'decisions': [], 'contract': {'goal': request, 'scope': sources,
                'constraints': ['UTF-8 text only', 'Protect originals', 'No external access'],
                'acceptance_criteria': ['Evidence briefing contains request and source excerpts/hashes',
                                        'Sources unchanged', 'Output independently verified'],
                'verification': 'Recompute briefing bytes and compare source SHA-256 snapshots',
                'result': None}}
        self.save(task, 'submitted')
        return task
