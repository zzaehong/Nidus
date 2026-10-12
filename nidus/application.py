"""Local UI projection and thin commands. Runtime owns every business transition."""
import hashlib
import json
import re
from .planning import PlanRuntime
from .runtime import Runtime, safe_path, output_hash
from .plan_model import DEFAULT_LIMITS


def revision(store, entity):
    resources = {name: output_hash(safe_path(store.vault, name))
                 for name in entity.get('sources', [])}
    if entity.get('output'):
        resources[entity['output']] = output_hash(safe_path(store.vault, entity['output']))
    if entity['id'].startswith('pln_'):
        resources['tasks'] = [revision(store, store.get(i)) for i in entity['tasks']]
    return hashlib.sha256(json.dumps([entity, resources], sort_keys=True).encode()).hexdigest()


def check_revision(store, entity, expected):
    if expected is not None and revision(store, entity) != expected:
        raise ValueError('STALE_STATE: State or resources changed; refresh before deciding')


class Application:
    def __init__(self, store):
        self.store = store
        self.planner = PlanRuntime(store)
        self.runtime = Runtime(store)

    def entity(self, kind, identity):
        if not isinstance(identity, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,160}', identity):
            raise ValueError('INVALID_ID: Invalid identifier')
        return self.store.get_plan(identity) if kind == 'plans' else self.store.get(identity)

    def attention(self, entity, kind):
        if entity['status'] != 'waiting' or not entity.get('attention'):
            return None
        a = entity['attention']
        quality = a.get('kind') in ('quality', 'task_quality')
        choices = list(a.get('choices', []))
        if kind == 'plans':
            actions = ['resume', 'cancel'] if quality else ['approve', 'reject']
            category = 'plan_resume' if a.get('kind') == 'task_quality' else 'plan_escalate' if quality else 'transmission'
            if a.get('kind') == 'task_quality' and self.store.get(a['task'])['status'] == 'waiting':
                actions = ['cancel']
        else:
            actions = ['approve', 'rework', 'cancel'] if quality else ['approve', 'reject']
            category = 'task_quality' if quality else 'overwrite' if 'output_hash' in a.get('snapshot', {}) else 'transmission'
        events = self.store.events(entity['id'])
        return {'id':entity['id'], 'entity':kind, 'plan_id':entity.get('plan_id'),
                'type':category, 'group':'quality' if quality else 'permission',
                'role':a.get('role', 'manager' if quality else 'worker'),
                'created_at':entity.get('created_at'), 'event_sequence':events[-1].get('seq') if events else None,
                'reason':a.get('reason', a.get('subject', 'Human decision required')),
                'scope':a, 'allowed_actions':actions, 'runtime_choices':choices,
                'revision':revision(self.store, entity)}

    def detail(self, kind, identity):
        e = self.entity(kind, identity)
        result = self.planner.board(identity) if kind == 'plans' else dict(e, history=self.store.events(identity))
        result['revision'] = revision(self.store, e)
        result['human_attention'] = self.attention(e, kind)
        result['allowed_actions'] = ['run'] if kind == 'plans' and e['status'] not in ('completed','cancelled','waiting') else []
        if kind == 'plans':
            result['progress'] = {'completed':sum(t['status']=='completed' for t in result['board']), 'total':len(result['board'])}
        return result

    def overview(self):
        plans = [self.detail('plans', p['id']) for p in self.store.plans()]
        archived = [self.detail('plans', p['id']) for p in self.store.plans(True)]
        tasks = [self.detail('tasks', t['id']) for t in self.store.tasks() + self.store.tasks(True)]
        attentions = [e['human_attention'] for e in plans + tasks if e['human_attention']]
        return {'plans':plans, 'archived_plans':archived, 'tasks':tasks, 'attentions':attentions,
                'summary':{'active_plans':sum(p['status']!='cancelled' for p in plans),
                'human_attentions':len(attentions), 'ready_tasks':sum(t['ready'] for p in plans for t in p['board']),
                'completed_plans':len(archived)},
                'settings':{'vault':str(self.store.vault), 'version':'Local GUI v1 / schema 2',
                'bind':'127.0.0.1', 'limits':DEFAULT_LIMITS, 'theme':'default-light',
                'policies':[{'plan':p['id'], 'planning':p['policy'], 'worker':p['worker_policy'],
                             'review':p['review_policy'], 'final':p['final_policy']} for p in plans]}}

    def create_plan(self, data):
        # Policies are non-secret JSON objects; no arbitrary host filesystem policy reads.
        return self.planner.submit(data['request'], data['sources'], data['policy'],
            data.get('worker_policy'), data.get('review_policy'), data.get('limits'), data.get('final_policy'))

    def command(self, kind, identity, action, data):
        self.entity(kind, identity)
        expected = data.get('revision')
        if not isinstance(expected, str) or len(expected) != 64:
            raise ValueError('STALE_STATE: Refresh to obtain a current revision')
        if kind == 'plans':
            if action == 'run':
                return self.planner.run(identity, expected_state=expected)
            if action == 'decision':
                return self.planner.decide(identity, data['decision'], data.get('note',''), expected_state=expected)
        elif action == 'decision':
            return self.runtime.decide(identity, data['decision'], expected_state=expected)
        elif action == 'quality':
            return self.runtime.quality_decide(identity, data['decision'], data.get('note',''),
                data.get('instructions', []), expected_state=expected)
        raise ValueError('INVALID_ACTION: Unknown command')
