"""Local UI projection and thin commands. Runtime owns every business transition."""
import hashlib
import json
import re
from .planning import PlanRuntime
from .runtime import Runtime, safe_path, output_hash
from .plan_model import DEFAULT_LIMITS
from .connections import ConnectionRegistry
from .gateway import Gateway, ModelError
from .plan_setup import (DEFAULT_SOURCE_SELECTION, model_candidates, policy_for,
                         suggest_sources)


def revision(store, entity):
    def resource_hash(name):
        try:
            return output_hash(safe_path(store.vault, name))
        except (ValueError, OSError) as error:
            return {'unavailable':str(error)}
    resources = {name: resource_hash(name) for name in entity.get('sources', [])}
    if entity.get('output'):
        resources[entity['output']] = resource_hash(entity['output'])
    if entity['id'].startswith('pln_'):
        resources['tasks'] = [revision(store, store.get(i)) for i in entity['tasks']]
    return hashlib.sha256(json.dumps([entity, resources], sort_keys=True).encode()).hexdigest()


def check_revision(store, entity, expected):
    if expected is not None and revision(store, entity) != expected:
        raise ValueError('STALE_STATE: State or resources changed; refresh before deciding')


class Application:
    def __init__(self, store, credentials=None):
        self.store = store
        self.connections = ConnectionRegistry(store,credentials)
        gateway=Gateway(connections=self.connections)
        self.planner = PlanRuntime(store,gateway)
        self.runtime = Runtime(store,gateway)

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
                'created_at':a.get('requested_at'), 'entity_created_at':entity.get('created_at'), 'event_sequence':events[-1].get('seq') if events else None,
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
                'human_attentions':len(attentions), 'ready_tasks':sum(t['ready'] for p in plans if 'run' in p['allowed_actions'] for t in p['board']),
                'completed_plans':len(archived)},
                'settings':{'vault':str(self.store.vault), 'version':'Local GUI v1 / schema 2',
                'bind':'127.0.0.1', 'limits':DEFAULT_LIMITS, 'theme':'default-light',
                'policies':[{'plan':p['id'], 'planning':p['policy'], 'worker':p['worker_policy'],
                             'review':p['review_policy'], 'final':p['final_policy']} for p in plans]}}

    def create_plan(self, data):
        if 'model_selection' in data:
            selected=data['model_selection']
            if not isinstance(selected,dict) or set(selected)!={'connection_id','model_id'}:
                raise ValueError('INVALID_MODEL_SELECTION: Choose a suggested model')
            candidates=model_candidates(self.connections,data['request'])
            candidate=next((c for c in candidates if c['connection_id']==selected['connection_id']
                and c['model_id']==selected['model_id']),None)
            if candidate is None:
                raise ModelError('model_unavailable')
            return self.planner.submit(data['request'],data['sources'],policy_for(candidate),
                limits=data.get('limits'))
        # Policies are non-secret JSON objects; no arbitrary host filesystem policy reads.
        return self.planner.submit(data['request'], data['sources'], data['policy'],
            data.get('worker_policy'), data.get('review_policy'), data.get('limits'), data.get('final_policy'))

    def suggest_plan_setup(self, request):
        if not isinstance(request,str) or not request.strip() or len(request)>8192:
            raise ValueError('INVALID_REQUEST: Enter a work request up to 8192 characters')
        sources=suggest_sources(self.store.vault,request)
        models=model_candidates(self.connections,request)
        if not models:
            raise ModelError('no_ready_connection')
        selected_sources=[item['path'] for item in sources[:DEFAULT_SOURCE_SELECTION]]
        selected=models[0]
        return {'request':request,'sources':sources,'selected_sources':selected_sources,
            'models':[{'connection_id':item['connection_id'],'model_id':item['model_id'],
                'provider':item['provider'],'connection_kind':item['connection_kind'],
                'connection_name':item['connection_name'],'manifest_name':item['manifest_name'],
                'route_kind':item['route_kind'],'latency_ms':item['latency_ms']}
                for item in models],
            'model_selection':{'connection_id':selected['connection_id'],'model_id':selected['model_id']},
            'policy':policy_for(selected),
            'notices':['구성 추천은 로컬에서 처리하며 요청·파일 내용을 전송하지 않습니다.',
                '실제 AI 호출 전에 전송 범위와 선택 모델을 확인하고 승인해야 합니다.',
                '연결 비용 정보는 제공되지 않을 수 있으며 유료 API 사용량이 발생할 수 있습니다.']}

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
