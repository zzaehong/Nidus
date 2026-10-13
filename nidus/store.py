import contextlib
import fcntl
import json
import sqlite3
import uuid
from pathlib import Path
from .versioning import VaultGit
from .paths import validate_vault_location


class Store:
    def __init__(self, vault):
        self.vault = validate_vault_location(vault)
        self.system = self.vault / '.nidus'
        if self.system.is_symlink():
            raise ValueError('System directory must not be a symlink')
        self.system.mkdir(parents=True, exist_ok=True)
        for name in ('state.sqlite3', 'runtime.lock', '.gitignore'):
            if (self.system / name).is_symlink():
                raise ValueError('System files must not be symlinks')
        self.versioning = None
        self._atomic = False
        with self.lock():
            ignore = self.system / '.gitignore'
            if not ignore.exists():
                ignore.write_text('runtime.lock\nstate.sqlite3-journal\n', encoding='utf-8')
            self.db = sqlite3.connect(str(self.system / 'state.sqlite3'))
            self.db.row_factory = sqlite3.Row
            version = self.db.execute('PRAGMA user_version').fetchone()[0]
            if version not in (0, 1, 2):
                raise ValueError('Unsupported vault schema')
            self.db.executescript('''
                CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, task TEXT, kind TEXT, data TEXT);
                CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, data TEXT NOT NULL);
                PRAGMA user_version=2;
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
                            if not self.db.execute('SELECT 1 FROM tasks WHERE id=?', (row[0],)).fetchone():
                                plan = self.get_plan(row[0])
                                if plan['status'] == 'completed':
                                    plan['invalidated_completion'] = json.loads(json.dumps(plan))
                                plan.update(status='blocked', error=str(error), result=None)
                                self.save_plan(plan, 'versioning_failed')
                                continue
                            task = self.get(row[0])
                            if task['status'] == 'completed':
                                task['invalidated_completion'] = json.loads(json.dumps(task))
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
        with self.transaction():
            self.db.execute('INSERT OR REPLACE INTO state VALUES (?,?)', (key, json.dumps(value)))

    def save(self, task, kind, detail=None):
        old = self.db.execute('SELECT data FROM tasks WHERE id=?', (task['id'],)).fetchone()
        if old and json.loads(old[0])['status'] == 'completed' and json.loads(old[0]) != task:
            previous = json.loads(old[0])
            allowed = json.loads(old[0])
            allowed.update(status='blocked', error=task.get('error'), invalidated_completion=previous)
            allowed['contract']['result'] = None
            if kind != 'versioning_failed' or task != allowed:
                raise ValueError('Completed task history is immutable')
        if old:
            previous = json.loads(old[0])
            for key in ('plan_id', 'local_key', 'created_manager', 'sequence', 'created_at'):
                if previous.get(key) != task.get(key):
                    raise ValueError('Task identity is immutable')
        with self.transaction():
            self.db.execute('INSERT OR REPLACE INTO tasks VALUES (?,?)', (task['id'], json.dumps(task)))
            self.db.execute('INSERT INTO events(task,kind,data) VALUES (?,?,?)',
                (task['id'], kind, json.dumps(detail if detail is not None else {'status': task['status']})))

    @contextlib.contextmanager
    def transaction(self):
        if self._atomic:
            yield
            return
        self._atomic = True
        try:
            with self.db:
                yield
        finally:
            self._atomic = False

    def get_plan(self, plan_id):
        row = self.db.execute('SELECT data FROM plans WHERE id=?', (plan_id,)).fetchone()
        if not row:
            raise ValueError('Unknown plan: ' + plan_id)
        return json.loads(row[0])

    def save_plan(self, plan, kind, detail=None, create=False):
        old = self.db.execute('SELECT data FROM plans WHERE id=?', (plan['id'],)).fetchone()
        if old and create:
            raise ValueError('Duplicate plan ID')
        if old and json.loads(old[0])['status'] == 'completed' and json.loads(old[0]) != plan:
            previous = json.loads(old[0])
            allowed = json.loads(old[0])
            allowed.update(status='blocked', error=plan.get('error'), result=None, invalidated_completion=previous)
            if kind != 'versioning_failed' or plan != allowed:
                raise ValueError('Completed plan is immutable')
        with self.transaction():
            self.db.execute('INSERT OR REPLACE INTO plans VALUES (?,?)', (plan['id'], json.dumps(plan)))
            self.db.execute('INSERT INTO events(task,kind,data) VALUES (?,?,?)',
                (plan['id'], kind, json.dumps(detail if detail is not None else {'status': plan['status']})))

    def plans(self, archive=False):
        values = [json.loads(r[0]) for r in self.db.execute('SELECT data FROM plans ORDER BY rowid')]
        return [p for p in values if (p['status'] == 'completed') == archive]

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

    def submit(self, request, sources, output, priority, mode='deterministic', model_policy=None, required_phrases=None,
               workflow=None, manager_contract=None, manager_policy=None, max_reworks=2, identity=None):
        from .gateway import reject_credentials, validate_policy
        if mode not in ('deterministic', 'generative'):
            raise ValueError('Unknown execution mode')
        policy = validate_policy(model_policy) if mode == 'generative' else None
        phrases = required_phrases or []
        if not isinstance(phrases, list) or len(phrases) > 20 or any(not isinstance(p, str) or not p.strip() or len(p) > 256 for p in phrases):
            raise ValueError('Provide up to 20 nonempty required phrases')
        reject_credentials(json.dumps([request, sources, output, phrases]), policy)
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
        if mode == 'generative':
            task.update(mode=mode, model_policy=policy, required_phrases=phrases)
            task['contract']['constraints'] = ['UTF-8 text only', 'Protect originals', 'Exact model transmission approval', 'No model tool execution']
            task['contract']['acceptance_criteria'] = ['Nonempty untruncated model response', 'All required literal phrases: ' + json.dumps(phrases), 'Sources unchanged', 'Output matches persisted model response and provenance']
            task['contract']['verification'] = 'Validate response and required phrases, source/prompt snapshot and exact artifact bytes'
        if workflow is not None:
            from .workflow import completion_contract
            if workflow != 'manager' or mode != 'generative':
                raise ValueError('Manager workflow requires generative execution')
            if type(max_reworks) is not int or not 0 <= max_reworks <= 10:
                raise ValueError('max_reworks must be an integer from 0 to 10')
            contract = completion_contract(request, sources, output, manager_contract)
            policy = validate_policy(dict(policy, response_format='json_object'))
            task['model_policy'] = policy
            review_policy = validate_policy(dict(manager_policy or policy, response_format='json_object'))
            reject_credentials(json.dumps([request, sources, output, phrases]), review_policy)
            reject_credentials(json.dumps(contract), policy)
            reject_credentials(json.dumps(contract), review_policy)
            task.update(workflow='manager', workflow_stage='worker_execution',
                manager='manager-1', manager_contract=contract, manager_policy=review_policy,
                max_reworks=max_reworks, rework_count=0, revisions=[], reviews=[])
            task['contract']['acceptance_criteria'].append('Independent Manager APPROVE on the current submission')
        if identity:
            task.update(identity)
        if self.db.execute('SELECT 1 FROM tasks WHERE id=?', (task['id'],)).fetchone():
            raise ValueError('Duplicate task ID')
        self.save(task, 'submitted')
        if workflow:
            self.save(task, 'manager_task_defined', {'manager': task['manager'], 'contract': contract,
                'assigned_worker': task['employee']})
        return task
