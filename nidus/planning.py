"""Sequential orchestration above the existing single-task responsibility loop."""
import copy
from .gateway import canonical, fingerprint, validate_policy, transmission, reject_credentials
from .runtime import Runtime, safe_path, sources_for, output_hash
from .workflow import completion_contract, check_criteria, strings
from .prompts.manager_planning import PLANNING
from .prompts.manager_completion import FINAL, ADJUSTMENT

from .plan_model import DEFAULT_LIMITS, TASK_FIELDS, PLAN_FIELDS, now, identifier, strict_object, validate_graph, ready_tasks


def plan_messages(task, records):
    instructions = PLANNING if task['plan_context'] == 'planning' else FINAL
    if task['plan_context'] == 'adjustment':
        instructions = ADJUSTMENT
    return [{'role':'system', 'content':instructions},
            {'role':'user', 'content':canonical(dict(task['context'],
                sources=[{'path':r['path'],'sha256':r['hash'],'text':r['text']} for r in records]))}]


def snapshot(store, plan):
    return fingerprint({'version':plan['plan_version'], 'contract':plan.get('contract'),
        'history':plan['plan_change_history'],
        'tasks':[store.get(i) for i in plan['tasks']]})


class PlanRuntime:
    def __init__(self, store, gateway=None):
        self.store = store
        self.runtime = Runtime(store, gateway)

    def submit(self, request, sources, policy, worker_policy=None, review_policy=None, limits=None, final_policy=None):
        with self.store.lock():
            policy = validate_policy(dict(policy, response_format='json_object'))
            worker = validate_policy(dict(worker_policy or policy, response_format='json_object'))
            review = validate_policy(dict(review_policy or policy, response_format='json_object'))
            final_policy = validate_policy(dict(final_policy or policy, response_format='json_object'))
            bounds = dict(DEFAULT_LIMITS, **(limits or {}))
            if set(bounds) != set(DEFAULT_LIMITS) or any(type(n) is not int or n < 0 for n in bounds.values()):
                raise ValueError('Invalid plan limits')
            if not 1 <= bounds['initial_tasks'] <= bounds['total_tasks'] <= 100 or bounds['revisions'] > 20:
                raise ValueError('Invalid plan limits')
            if not isinstance(request, str) or not request.strip() or not strings(sources, True) or len(set(sources)) != len(sources) or len(sources) > 20:
                raise ValueError('Nonempty request and 1–20 unique sources required')
            records = sources_for(self.store, {'sources':sources})
            for p in (policy, worker, review, final_policy):
                reject_credentials(canonical([request,records]), p)
            plan = {'id':identifier('pln'), 'original_request':request, 'goal':None,
                'manager':'manager-1', 'created_at':now(), 'status':'planning', 'plan_version':0,
                'sources':sources, 'policy':policy, 'worker_policy':worker, 'review_policy':review,
                'final_policy':final_policy,
                'cancelled_tasks':[],
                'limits':bounds, 'tasks':[], 'specs':[], 'mapping':{}, 'plan_change_history':[],
                'decisions':[], 'final_reviews':[], 'final_review':None, 'result':None}
            self.store.save_plan(plan, 'plan_submitted', create=True)
            return plan

    def board(self, plan_id):
        plan = self.store.get_plan(plan_id)
        tasks = [self.store.get(i) for i in plan['tasks']]
        ready = self.ready(tasks)
        return dict(plan, board=[{**{k:t.get(k) for k in ('id','local_key','title','goal','status',
            'priority','depends_on','assigned_manager','assigned_worker','result_reference')},
            'result_reference':t['contract'].get('result'),
            'ready':t['id'] in ready} for t in tasks], history=self.store.events(plan_id))

    ready = staticmethod(ready_tasks)

    def call(self, plan, purpose):
        context = {'original_request':plan['original_request'], 'allowed_sources':plan['sources'],
                   'limits':plan['limits']}
        if purpose != 'planning':
            context.update(contract=plan['contract'], plan=self.board(plan['id'])['board'],
                plan_change_history=plan['plan_change_history'],
                results=[self.store.get(i) for i in plan['tasks']],
                adjustment_reason=plan.get('adjustment_reason'))
            context['human_context'] = plan.get('human_context')
            # Keep task evidence separate from the top-level criterion checklist.
            context['results'] = [{'task_id':t['id'],'local_key':t['local_key'],'status':t['status'],
                'result':t.get('submission',{}).get('result'),
                'limitations':t.get('submission',{}).get('known_limitations',[]),
                'questions':t.get('submission',{}).get('questions',[]),
                'approved_result':t['contract'].get('result'), 'approval':t.get('manager_approval'),
                'manager_review':t.get('manager_review'), 'error':t.get('error')}
                for t in context['results']]
        return {'id':plan['id'], 'request':plan['original_request'], 'required_phrases':[],
                'model_policy':plan['policy'] if purpose == 'planning' else plan['final_policy'], 'worker_policy':plan['worker_policy'],
                'additional_policies':[plan['policy'],plan['final_policy']],
                'manager_policy':plan['review_policy'], 'plan_context':purpose, 'context':context}

    def model(self, plan, purpose):
        records = sources_for(self.store, plan)
        call = self.call(plan, purpose)
        scope = transmission(call, records)
        generation = plan.get('pending_generation')
        if generation and generation['snapshot'] == scope:
            return strict_object(generation['text']), scope
        if not any(d['decision'] == 'approve' and d['snapshot'] == scope for d in plan['decisions']):
            plan.update(status='waiting', attention={'kind':'transmission', 'role':'manager',
                'purpose':purpose, 'snapshot':scope, 'choices':['approve','reject']})
            self.store.save_plan(plan, 'plan_permission_ask', plan['attention'])
            return None, scope
        plan['pending_generation'] = self.runtime.gateway.generate(call, records,
            lambda kind, detail:self.store.save_plan(plan, kind, detail))
        self.store.save_plan(plan, 'plan_response_received')
        # Never interpret stale output after sources changed during the call.
        if transmission(self.call(plan, purpose), sources_for(self.store, plan)) != scope:
            raise ValueError('Plan model snapshot changed during call')
        return strict_object(plan['pending_generation']['text']), scope

    def materialize(self, plan, specs):
        mapping = dict(plan['mapping'])
        new = [s for s in specs if s['local_key'] not in mapping]
        identities = {}
        for index, spec in enumerate(new, len(mapping)+1):
            key = spec['local_key']
            identities[key] = {'id':identifier('tsk', plan['manager'], plan['id'], index),
                'plan_id':plan['id'], 'local_key':key, 'sequence':index, 'created_at':now(),
                'created_manager':plan['manager'], 'assigned_manager':plan['manager'],
                'assigned_worker':'worker-1', 'title':spec['title'], 'goal':spec['goal']}
            mapping[key] = identities[key]['id']
        for spec in new:
            contract = self.task_contract(plan, spec)
            identity = dict(identities[spec['local_key']], depends_on=[mapping[d] for d in spec['depends_on']])
            identity.update(parent_request=plan['original_request'], plan_contract=copy.deepcopy(plan['contract']))
            identity['additional_policies'] = [plan['policy'],plan['final_policy']]
            task = self.store.submit(spec['goal'], spec['sources'], spec['expected_output'], spec['priority'],
                mode='generative', model_policy=plan['worker_policy'], manager_policy=plan['review_policy'],
                workflow='manager', manager_contract=contract, identity=identity)
            plan['tasks'].append(task['id'])
        plan.update(mapping=mapping, specs=copy.deepcopy(specs))

    def task_contract(self, plan, spec):
        contract = completion_contract(spec['goal'], spec['sources'], spec['expected_output'])
        contract['completion_criteria'] = [{'id':'C'+str(i),'description':c}
            for i,c in enumerate(spec['completion_criteria'],1)]
        contract['constraints'] = list(dict.fromkeys(contract['constraints']+plan['contract']['constraints']))
        return completion_contract(spec['goal'],spec['sources'],spec['expected_output'],contract)

    def validate_resources(self, plan, specs):
        owned = set(plan['tasks'])
        external = {str(safe_path(self.store.vault,t['output']))
            for t in self.store.tasks()+self.store.tasks(True) if t['id'] not in owned}
        if any(str(safe_path(self.store.vault,s['expected_output'])) in external for s in specs):
            raise ValueError('Output already owned by another Task')

    def unstarted(self, plan, key):
        if not isinstance(key,str) or key not in plan['mapping']:
            raise ValueError('Unknown change target')
        task = self.store.get(plan['mapping'][key])
        if task['status'] != 'queued' or any(e['kind']=='claimed' for e in self.store.events(task['id'])):
            raise ValueError('Only never-started queued tasks can change')
        return task

    def install(self, plan, value):
        staged = copy.deepcopy(plan)
        self._install(staged, value)
        plan.clear()
        plan.update(staged)

    def _install(self, plan, value):
        if plan['plan_version'] != 0 or plan['tasks']:
            raise ValueError('Initial plan is already installed')
        if set(value) != PLAN_FIELDS:
            raise ValueError('Invalid planning response fields')
        for policy in (plan['policy'],plan['worker_policy'],plan['review_policy'],plan['final_policy']):
            reject_credentials(canonical(value), policy)
        for k in ('goal','scope','expected_result','planning_reason'):
            if not isinstance(value[k], str) or not value[k].strip():
                raise ValueError('Empty planning field')
        for k in ('completion_criteria','constraints','human_judgment_conditions'):
            if not strings(value[k], True):
                raise ValueError('Invalid top-level contract')
        validate_graph(self.store, value['tasks'], plan['sources'], plan['limits']['initial_tasks'])
        contract = completion_contract(value['goal'], plan['sources'], value['expected_result'])
        contract.update(scope=value['scope'], constraints=value['constraints'],
            human_judgment_conditions=value['human_judgment_conditions'],
            completion_criteria=[{'id':'C'+str(i),'description':c} for i,c in enumerate(value['completion_criteria'],1)])
        completion_contract(value['goal'], plan['sources'], value['expected_result'], contract)
        self.validate_resources(plan, value['tasks'])
        with self.store.transaction():
            plan.update(goal=value['goal'], contract=contract, planning_response=value, status='active', plan_version=1)
            self.materialize(plan, value['tasks'])
            plan['plan_change_history'].append({'version':1,'timestamp':now(),'authority':plan['manager'],
                'reason':value['planning_reason'], 'operations':[{'action':'initial_plan','tasks':value['tasks']}],
                'affected_tasks':list(plan['tasks']), 'previous_plan_hash':None,
                'new_plan_hash':fingerprint({'tasks':value['tasks'],'cancelled_tasks':[]})})
            plan.pop('pending_generation', None)
            plan.pop('attention', None)
            self.store.save_plan(plan, 'plan_created', plan['plan_change_history'][-1])

    def apply_change(self, plan_id, change):
        # Public changes are Manager proposals, validated under the same vault lock.
        with self.store.lock():
            plan = self.store.get_plan(plan_id)
            self.change(plan, change)
            return plan

    def change(self, plan, change):
        staged = copy.deepcopy(plan)
        self._change(staged, change)
        plan.clear()
        plan.update(staged)

    def _change(self, plan, change):
        if plan['plan_version'] == 0:
            raise ValueError('Initial planning must complete before changes')
        if plan['status'] in ('completed','cancelled'):
            raise ValueError('Terminal plan is immutable')
        if (not isinstance(change, dict) or set(change) != {'reason','operations'}
                or not isinstance(change['reason'],str) or not change['reason'].strip()
                or not isinstance(change['operations'],list) or not change['operations']):
            raise ValueError('Invalid change proposal')
        if plan['plan_version']-1 >= plan['limits']['revisions']:
            raise ValueError('Plan revision limit reached')
        specs, cancellations, modified = copy.deepcopy(plan['specs']), [], set()
        by_key = {s['local_key']:s for s in specs}
        for op in change['operations']:
            if not isinstance(op,dict):
                raise ValueError('Invalid operation')
            action = op.get('action')
            if action == 'add_task' and set(op)=={'action','task'}:
                spec = op['task']
                if not isinstance(spec,dict) or not isinstance(spec.get('local_key'),str) or spec['local_key'] in by_key:
                    raise ValueError('Invalid or reused local key')
                specs.append(spec)
                by_key[spec['local_key']] = spec
                continue
            if action not in ('cancel_unstarted_task','modify_unstarted_task','add_dependency','remove_dependency'):
                raise ValueError('Unsupported plan operation')
            key = op.get('task')
            # Newly added Tasks are edited in their add_task spec, not via mutations.
            task = self.unstarted(plan,key)
            if task['id'] in cancellations:
                raise ValueError('Cancelled task cannot change again')
            spec = by_key[key]
            if action == 'cancel_unstarted_task' and set(op)=={'action','task'}:
                cancellations.append(task['id'])
            elif action == 'modify_unstarted_task' and set(op)=={'action','task','changes'}:
                changes = op['changes']
                allowed = TASK_FIELDS-{'local_key','depends_on'}
                if not isinstance(changes,dict) or not changes or set(changes)-allowed:
                    raise ValueError('Invalid task modifications')
                spec.update(changes)
                modified.add(key)
            elif action in ('add_dependency','remove_dependency') and set(op)=={'action','task','depends_on'}:
                dependency = op['depends_on']
                if not isinstance(dependency,str) or dependency not in by_key:
                    raise ValueError('Invalid dependency reference')
                dependencies = spec['depends_on']
                if action == 'add_dependency':
                    if dependency in dependencies:
                        raise ValueError('Duplicate dependency')
                    dependencies.append(dependency)
                else:
                    if dependency not in dependencies:
                        raise ValueError('Missing dependency to remove')
                    dependencies.remove(dependency)
                modified.add(key)
            else:
                raise ValueError('Invalid operation fields')
        validate_graph(self.store, specs, plan['sources'], plan['limits']['total_tasks'])
        for policy in (plan['policy'],plan['worker_policy'],plan['review_policy'],plan['final_policy']):
            reject_credentials(canonical(change), policy)
        self.validate_resources(plan, specs)
        previous = fingerprint({'tasks':plan['specs'],'cancelled_tasks':plan['cancelled_tasks']})
        before = set(plan['tasks'])
        with self.store.transaction():
            self.materialize(plan, specs)
            for key in modified:
                task = self.store.get(plan['mapping'][key])
                spec = by_key[key]
                contract = self.task_contract(plan,spec)
                task.update(title=spec['title'],goal=spec['goal'],request=spec['goal'],
                    sources=spec['sources'],output=spec['expected_output'],priority=spec['priority'],
                    depends_on=[plan['mapping'][d] for d in spec['depends_on']],manager_contract=contract)
                task['contract'].update(goal=spec['goal'],scope=spec['sources'])
                task.pop('dependency_results',None)
                self.store.save(task,'plan_task_modified',{'reason':change['reason'],'spec':spec})
            for task_id in cancellations:
                task = self.store.get(task_id)
                task['status'] = 'cancelled'
                self.store.save(task, 'plan_task_cancelled', {'reason':change['reason']})
            plan['plan_version'] += 1
            plan['cancelled_tasks'] = sorted(set(plan['cancelled_tasks'] + cancellations))
            plan['plan_change_history'].append({'version':plan['plan_version'],'timestamp':now(),
                'authority':plan['manager'],'reason':change['reason'],'operations':change['operations'],
                'affected_tasks':sorted((set(plan['tasks'])-before)|set(cancellations)|{plan['mapping'][k] for k in modified}),
                'previous_plan_hash':previous,'new_plan_hash':fingerprint({'tasks':specs,'cancelled_tasks':plan['cancelled_tasks']})})
            plan.update(status='active', final_review=None)
            for key in ('pending_generation','attention','adjustment_reason','adjustment_snapshot'):
                plan.pop(key, None)
            self.store.save_plan(plan, 'plan_changed', plan['plan_change_history'][-1])

    def references(self, plan, task):
        refs = []
        for task_id in task['depends_on']:
            dep = self.store.get(task_id)
            if dep['status'] != 'completed' or not dep.get('manager_approval'):
                raise ValueError('Dependency not approved')
            result = dep['contract']['result']
            if output_hash(safe_path(self.store.vault, result['output'])) != result['sha256']:
                raise ValueError('Approved dependency output changed; new review Task required')
            refs.append({'task_id':task_id, 'plan_id':plan['id'], 'output':result['output'],
                'output_hash':result['sha256'], 'completion_state':'completed',
                'approval':dep['manager_approval'], 'result':dep['submission']['result']})
        if task.get('dependency_results') is not None and task['dependency_results'] != refs:
            raise ValueError('Dependency result snapshot changed')
        task['dependency_results'] = refs
        self.store.save(task, 'dependency_results_bound', refs)

    def final(self, plan):
        binding = snapshot(self.store, plan)
        tasks = [self.store.get(i) for i in plan['tasks']]
        purpose = 'final_review' if all(t['status'] in ('completed','cancelled') for t in tasks) else 'adjustment'
        value, scope = self.model(plan, purpose)
        if value is None:
            return
        if snapshot(self.store, plan) != binding:
            raise ValueError('Final review task snapshot changed')
        choices = ('COMPLETE','ADD_TASKS','ESCALATE') if purpose == 'final_review' else ('CONTINUE','CHANGE_PLAN','ADD_TASKS','ESCALATE')
        if set(value) != {'decision','reason','criteria','questions','change'} or value['decision'] not in choices:
            raise ValueError('Invalid final review')
        if not isinstance(value['reason'],str) or not value['reason'].strip() or not strings(value['questions']):
            raise ValueError('Invalid final reasoning')
        check_criteria(value['criteria'], plan['contract'])
        review = {'binding':binding,'transmission':scope,'review':value,'generation':plan['pending_generation']}
        plan['final_reviews'].append(review)
        plan['final_review'] = review
        self.store.save_plan(plan, 'plan_final_reviewed', review)
        if value['decision'] == 'CONTINUE':
            if value['change'] is not None or value['questions'] or not self.ready(tasks):
                raise ValueError('CONTINUE requires ready work and no change or unresolved questions')
            plan.update(status='active', adjustment_snapshot=binding)
            for key in ('pending_generation','attention','adjustment_reason'):
                plan.pop(key, None)
            self.store.save_plan(plan, 'plan_continued', review)
        elif value['decision'] == 'COMPLETE':
            tasks = [self.store.get(i) for i in plan['tasks']]
            if (value['change'] is not None or value['questions']
                    or any(c['status'] != 'satisfied' for c in value['criteria'])
                    or any(t['status'] not in ('completed','cancelled') for t in tasks)
                    or not any(t['status'] == 'completed' for t in tasks)):
                raise ValueError('Inconsistent COMPLETE')
            for t in tasks:
                if t['status'] == 'completed':
                    result = t['contract']['result']
                    if output_hash(safe_path(self.store.vault, result['output'])) != result['sha256']:
                        raise ValueError('Approved output changed before final completion')
            plan.update(status='completed', result={'snapshot':binding,
                'outputs':[t['contract']['result'] for t in tasks if t['status'] == 'completed'],
                'archived_at':now()})
            plan.pop('attention', None)
            self.store.save_plan(plan, 'plan_archived', plan['result'])
        elif value['decision'] in ('ADD_TASKS','CHANGE_PLAN'):
            if (not isinstance(value['change'],dict)
                    or not isinstance(value['change'].get('operations'),list)
                    or (value['decision']=='ADD_TASKS' and not any(isinstance(op,dict) and op.get('action') == 'add_task' for op in value['change']['operations']))):
                raise ValueError('ADD_TASKS requires new tasks')
            self.change(plan, value['change'])
        else:
            if not value['questions'] or value['change'] is not None:
                raise ValueError('ESCALATE requires questions and no changes')
            plan.update(status='waiting', attention={'kind':'quality','reason':value['reason'],
                'questions':value['questions'],'snapshot':binding,'choices':['resume','cancel']})
            self.store.save_plan(plan, 'plan_escalated', plan['attention'])

    def decide(self, plan_id, decision, note=''):
        with self.store.lock():
            plan = self.store.get_plan(plan_id)
            if plan['status'] != 'waiting':
                raise ValueError('Plan is not waiting')
            attention = plan['attention']
            for policy in (plan['policy'],plan['worker_policy'],plan['review_policy'],plan['final_policy']):
                reject_credentials(note, policy)
            if attention['kind'] in ('quality','task_quality'):
                if decision not in ('resume','cancel') or not note.strip():
                    raise ValueError('Quality decisions require resume/cancel and a reason')
                if attention['kind'] == 'task_quality' and decision == 'resume':
                    if self.store.get(attention['task'])['status'] == 'waiting':
                        raise ValueError('Resolve the Task quality decision first')
                for p in (plan['policy'],plan['worker_policy'],plan['review_policy']):
                    reject_credentials(note, p)
                plan['status'] = 'active' if decision == 'resume' else 'cancelled'
                plan.pop('pending_generation', None)
                plan['human_context'] = note
            else:
                if decision not in ('approve','reject'):
                    raise ValueError('Transmission decision requires approve/reject')
                plan['status'] = ('planning' if attention['purpose'] == 'planning' else 'final_review') if decision == 'approve' else 'cancelled'
            plan['decisions'].append({'decision':decision,'snapshot':attention['snapshot'],'note':note,
                                      'kind':attention['kind']})
            plan.pop('attention', None)
            self.store.save_plan(plan, 'plan_human_decision', plan['decisions'][-1])
            return plan

    def run(self, plan_id):
        # One explicitly resumable step; never an unbounded model loop.
        with self.store.lock():
            plan = self.store.get_plan(plan_id)
            if plan['status'] in ('completed','cancelled','waiting'):
                return plan
            try:
                if plan['plan_version'] == 0:
                    value, _ = self.model(plan, 'planning')
                    if value is not None:
                        self.install(plan, value)
                    return plan
                if plan['status'] == 'final_review':
                    self.final(plan)
                    return plan
                tasks = [self.store.get(i) for i in plan['tasks']]
                if any(t['status'] in ('running','verifying','waiting') for t in tasks):
                    task = next(t for t in tasks if t['status'] in ('running','verifying','waiting'))
                    if task['status'] == 'waiting':
                        plan.update(status='active', current_task=task['id'])
                        self.store.save_plan(plan, 'plan_task_waiting')
                        return plan
                else:
                    ready = self.ready(tasks)
                    task = self.store.get(ready[0]) if ready else None
                if task:
                    self.references(plan, task)
                    plan.update(current_task=task['id'], status='active')
                    self.store.save_plan(plan, 'plan_task_selected', {'task':task['id'], 'ready':self.ready(tasks)})
                    result = self.runtime.run(task['id'], lock_owned=True)
                    self.store.save_plan(plan, 'plan_task_step', {'task':task['id'],'status':result['status']})
                    if result['status'] == 'blocked':
                        plan.update(status='final_review', adjustment_reason='Task blocked: '+result.get('error',''))
                        self.store.save_plan(plan, 'plan_adjustment_needed')
                    if result['status'] == 'waiting' and result.get('attention',{}).get('kind') == 'quality':
                        plan.update(status='waiting', attention={'kind':'task_quality', 'task':task['id'],
                            'reason':'Assigned Task requires human quality judgment',
                            'snapshot':snapshot(self.store,plan), 'choices':['resume','cancel']})
                        self.store.save_plan(plan, 'plan_escalated', plan['attention'])
                    if result['status'] == 'completed' and (result['submission']['questions'] or result['submission']['known_limitations']):
                        state = snapshot(self.store, plan)
                        if plan.get('adjustment_snapshot') != state:
                            plan.update(adjustment_reason='Worker reported questions or limitations',
                                        adjustment_snapshot=state, status='final_review')
                            self.store.save_plan(plan, 'plan_adjustment_needed')
                    return plan
                else:
                    if any(t['status'] not in ('completed','cancelled') for t in tasks):
                        plan['adjustment_reason'] = 'No ready tasks; blocked or cancelled dependencies require Manager judgment'
                    plan['status'] = 'final_review'
                    self.final(plan)
                    return plan
            except (ValueError, OSError) as error:
                plan.update(status='blocked', error=str(error), result=None)
                self.store.save_plan(plan, 'plan_blocked', {'reason':str(error)})
                return plan
