"""Deterministic plan identities, proposal validation and graph scheduling."""
import json
import re
import uuid
from datetime import datetime, timezone
from .runtime import safe_path
from .workflow import strings

DEFAULT_LIMITS = {'initial_tasks':10, 'total_tasks':20, 'revisions':5}
TASK_FIELDS = {'local_key','title','goal','priority','depends_on','sources','completion_criteria','expected_output'}
PLAN_FIELDS = {'goal','scope','completion_criteria','constraints','expected_result','human_judgment_conditions','planning_reason','tasks'}


def now():
    return datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')


def identifier(kind, manager='manager-1', plan=None, sequence=None):
    parts = [kind, now(), manager.replace('-', '')]
    if plan is not None:
        parts += [plan.rsplit('_',1)[-1], '%03d' % sequence]
    return '_'.join(parts + [uuid.uuid4().hex[:12]])


def strict_object(text):
    def unique(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError('Duplicate JSON field')
            value[key] = item
        return value
    def invalid(_):
        raise ValueError('Non-finite JSON number')
    value = json.loads(text, object_pairs_hook=unique, parse_constant=invalid)
    if not isinstance(value,dict):
        raise ValueError('Expected JSON object')
    return value


def validate_graph(store, specs, allowed, maximum):
    if not isinstance(specs,list) or not 1 <= len(specs) <= maximum:
        raise ValueError('Task count limit exceeded or empty plan')
    keys, outputs = {}, set()
    original_paths = {str(safe_path(store.vault,s)) for s in allowed}
    for spec in specs:
        if not isinstance(spec,dict) or set(spec) != TASK_FIELDS:
            raise ValueError('Invalid task proposal fields')
        key = spec['local_key']
        if not isinstance(key,str) or not re.fullmatch(r'T[1-9][0-9]*',key) or key in keys:
            raise ValueError('Invalid or duplicate local key')
        for name in ('title','goal','expected_output'):
            if not isinstance(spec[name],str) or not spec[name].strip():
                raise ValueError('Empty task '+name)
        if type(spec['priority']) is not int or not 1 <= spec['priority'] <= 100:
            raise ValueError('Invalid priority')
        if not strings(spec['completion_criteria'],True) or len(spec['completion_criteria']) > 20:
            raise ValueError('Missing or excessive completion criteria')
        if not strings(spec['sources'],True) or len(spec['sources']) > 20 or len(set(spec['sources'])) != len(spec['sources']):
            raise ValueError('Invalid sources')
        for source in spec['sources']:
            safe_path(store.vault,source)
        output = str(safe_path(store.vault,spec['expected_output']))
        if output in outputs or output in original_paths:
            raise ValueError('Output resource collision')
        outputs.add(output)
        if not strings(spec['depends_on']) or len(set(spec['depends_on'])) != len(spec['depends_on']):
            raise ValueError('Invalid dependencies')
        keys[key] = spec
    for spec in specs:
        dependency_outputs = {keys[d]['expected_output'] for d in spec['depends_on'] if d in keys}
        if any(s not in allowed and s not in dependency_outputs for s in spec['sources']):
            raise ValueError('Unselected source or non-dependency output')
    visiting, visited = set(), set()
    def visit(key):
        if key in visiting:
            raise ValueError('Dependency cycle')
        if key in visited:
            return
        visiting.add(key)
        for dependency in keys[key]['depends_on']:
            if dependency not in keys or dependency == key:
                raise ValueError('Invalid dependency reference')
            visit(dependency)
        visiting.remove(key)
        visited.add(key)
    for key in keys:
        visit(key)


def ready_tasks(tasks):
    states = {t['id']:t['status'] for t in tasks}
    order = sorted(tasks, key=lambda t:(t['priority'],t['sequence'],t['created_at'],t['id']))
    return [t['id'] for t in order if t['status'] == 'queued'
            and all(states.get(d) == 'completed' for d in t['depends_on'])]
