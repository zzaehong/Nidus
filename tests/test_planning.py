import copy
import json
import os
import unittest
from unittest.mock import Mock, patch
import test_runtime
from nidus.store import Store
from nidus.gateway import Gateway, default_policy
from nidus.planning import PlanRuntime, strict_object, validate_graph, snapshot


class PlanTests(unittest.TestCase):
    setUp = test_runtime.RuntimeTests.setUp
    tearDown = test_runtime.RuntimeTests.tearDown

    def spec(self, n=1, deps=None, priority=1):
        return {'local_key':'T'+str(n),'title':'Task '+str(n),'goal':'Summarize supplied facts',
            'priority':priority,'depends_on':deps or [],'sources':['notes.md'],
            'completion_criteria':['Ground summary in source'], 'expected_output':'results/task'+str(n)+'.md'}

    def proposal(self, specs=None):
        return {'goal':'Make a grounded report','scope':'Selected synthetic source only',
            'completion_criteria':['Report supported facts'], 'constraints':['No invented facts'],
            'expected_result':'Grounded report', 'human_judgment_conditions':['Insufficient evidence'],
            'planning_reason':'Minimal sufficient steps', 'tasks':specs or [self.spec()]}

    def worker(self, questions=None):
        return {'result':'Supported source summary', 'self_check':[
            {'criterion_id':'C1','status':'satisfied','reason':'Grounded in supplied source'}],
            'known_limitations':[], 'questions':questions or []}

    def review(self, decision='APPROVE'):
        return {'decision':decision,'criteria':self.worker()['self_check'],'reason':'Evidence reviewed',
            'issues':['Missing fact'] if decision == 'REWORK' else [],
            'instructions':['Include fact'] if decision == 'REWORK' else [],
            'questions':['Need human judgment'] if decision == 'ESCALATE' else []}

    def final(self, choice='COMPLETE', change=None):
        return {'decision':choice,'criteria':self.worker()['self_check'],'reason':'Goal reviewed',
            'questions':['Choose acceptable scope'] if choice == 'ESCALATE' else [],'change':change}

    def setup_plan(self, specs=None, responses=None, limits=None):
        adapter = Mock()
        values = responses or []
        adapter.generate.side_effect = [{'text':json.dumps(v),'finish_reason':'stop','model':'fake',
            'tokens':None,'estimated_cost_usd':None} for v in values]
        runtime = PlanRuntime(self.store, Gateway(adapter))
        plan = runtime.submit('Write a supported report', ['notes.md'], default_policy(), limits=limits)
        if specs is not None:
            with self.store.lock():
                runtime.install(plan, self.proposal(specs))
        return runtime, plan, adapter

    def advance(self, runtime, plan, until='completed', maximum=40):
        for _ in range(maximum):
            result = runtime.run(plan['id'])
            if result['status'] == until:
                return result
            if result['status'] in ('blocked','cancelled'):
                return result
            if result['status'] == 'waiting':
                if result['attention']['kind'] != 'transmission':
                    return result
                runtime.decide(plan['id'],'approve')
            for tid in result['tasks']:
                task = self.store.get(tid)
                if task['status'] == 'waiting':
                    if task['attention'].get('kind') == 'quality':
                        return result
                    runtime.runtime.decide(tid,'approve')
        self.fail('Bounded harness exhausted')

    def test_three_task_chain_planning_final_archive_and_references(self):
        specs = [self.spec(),self.spec(2,['T1']),self.spec(3,['T2'])]
        responses = [self.proposal(specs)] + [v for _ in specs for v in (self.worker(),self.review())] + [self.final()]
        runtime, plan, adapter = self.setup_plan(responses=responses)
        result = self.advance(runtime, plan)
        self.assertEqual(result['status'],'completed', result.get('error'))
        self.assertEqual(adapter.generate.call_count,8)
        self.assertEqual(len(self.store.plans(True)),1)
        self.assertEqual(len(self.store.tasks(True)),3)
        t2 = self.store.get(result['mapping']['T2'])
        ref = t2['dependency_results'][0]
        self.assertEqual(ref['task_id'],result['mapping']['T1'])
        self.assertEqual(ref['output_hash'],self.store.get(ref['task_id'])['contract']['result']['sha256'])
        self.assertEqual(ref['completion_state'],'completed')
        self.assertEqual(result['final_review']['binding'],snapshot(self.store,result))
        self.assertIn('tsk_',t2['id'])
        self.assertEqual(t2['created_manager'],'manager-1')

    def test_priority_sequence_and_one_task_per_step(self):
        specs = [self.spec(priority=2),self.spec(2,priority=1),self.spec(3,priority=1)]
        runtime, plan, adapter = self.setup_plan(specs,[self.worker(),self.review()])
        self.assertEqual(runtime.board(plan['id'])['board'][0]['ready'],True)
        runtime.run(plan['id'])
        t2 = self.store.get(plan['mapping']['T2'])
        self.assertEqual(t2['status'],'waiting')
        self.assertEqual(self.store.get(plan['mapping']['T1'])['status'],'queued')
        self.assertEqual(self.store.get(plan['mapping']['T3'])['status'],'queued')
        self.assertEqual(adapter.generate.call_count,0)

    def test_dependency_requires_all_completed(self):
        specs = [self.spec(),self.spec(2),self.spec(3,['T1','T2'])]
        runtime, plan, _ = self.setup_plan(specs,[self.worker(),self.review()])
        for _ in range(3):
            p = runtime.run(plan['id'])
            t = self.store.get(p['current_task'])
            if t['status'] == 'waiting': runtime.runtime.decide(t['id'],'approve')
        board = runtime.board(plan['id'])['board']
        self.assertEqual(board[0]['status'],'completed')
        self.assertFalse(board[2]['ready'])

    def test_invalid_graphs_and_schema_rejected_before_persistence(self):
        cases = [[self.spec(1,['T1'])], [self.spec(1,['T9'])],
            [self.spec(1,['T2']),self.spec(2,['T3']),self.spec(3,['T1'])],
            [self.spec(),self.spec()]]
        for field,value in [('goal',''),('completion_criteria',[]),('priority',True),
            ('priority','1'),('sources',['../private.md']),('expected_output','notes.md')]:
            spec = self.spec(); spec[field] = value; cases.append([spec])
        spec = self.spec(2); spec['expected_output'] = self.spec()['expected_output']
        cases.append([self.spec(),spec])
        for specs in cases:
            runtime, plan, _ = self.setup_plan()
            with self.assertRaises(ValueError):
                runtime.install(plan,self.proposal(specs))
            self.assertEqual(self.store.get_plan(plan['id'])['tasks'],[])
        self.assertEqual(self.store.tasks(),[])

    def test_strict_json_no_repairs(self):
        for text in ('```json\n{}\n```','{"a":1,"a":2}','{"a":NaN}','[]','{} trailing'):
            with self.assertRaises(ValueError): strict_object(text)

    def test_rework_preserves_dependency_lock(self):
        specs = [self.spec(),self.spec(2,['T1'])]
        runtime, plan, _ = self.setup_plan(specs,[self.worker(),self.review('REWORK'),self.worker(),self.review(),self.worker(),self.review(),self.final()])
        result = self.advance(runtime,plan)
        self.assertEqual(result['status'],'completed',result.get('error'))
        task = self.store.get(result['mapping']['T1'])
        self.assertEqual(task['rework_count'],1)
        self.assertEqual(len(task['revisions']),1)
        self.assertEqual(self.store.get(result['mapping']['T2'])['dependency_results'][0]['output_hash'],task['candidate_hash'])

    def test_worker_escalation_stops_dependents(self):
        runtime, plan, adapter = self.setup_plan([self.spec(),self.spec(2,['T1'])],[self.worker(),self.review('ESCALATE')])
        self.advance(runtime,plan)
        self.assertEqual(self.store.get(plan['mapping']['T1'])['status'],'waiting')
        self.assertFalse(runtime.board(plan['id'])['board'][1]['ready'])
        runtime.run(plan['id'])
        self.assertEqual(adapter.generate.call_count,2)

    def test_dynamic_additions_and_final_add_tasks(self):
        change = {'reason':'Need integration summary','operations':[{'action':'add_task','task':self.spec(2,['T1'])}]}
        responses = [self.worker(),self.review(),self.final('ADD_TASKS',change),self.worker(),self.review(),self.final()]
        runtime, plan, adapter = self.setup_plan([self.spec()],responses)
        result = self.advance(runtime,plan)
        self.assertEqual(result['status'],'completed',result.get('error'))
        self.assertEqual(result['plan_version'],2)
        self.assertEqual(len(result['final_reviews']),2)
        history = result['plan_change_history'][1]
        self.assertNotEqual(history['previous_plan_hash'],history['new_plan_hash'])
        self.assertEqual(adapter.generate.call_count,6)

    def test_follow_up_triggers_manager_before_ready_task(self):
        change = {'reason':'Check follow-up','operations':[{'action':'add_task','task':self.spec(3,['T1'])}]}
        responses = [self.worker(['Need a follow-up']),self.review(),self.final('ADD_TASKS',change)]
        runtime, plan, adapter = self.setup_plan([self.spec(),self.spec(2,['T1'])],responses)
        for _ in range(5):
            p = runtime.run(plan['id'])
            if p['status'] == 'waiting': runtime.decide(plan['id'],'approve')
            for tid in p['tasks']:
                t = self.store.get(tid)
                if t['status'] == 'waiting': runtime.runtime.decide(tid,'approve')
        p = self.store.get_plan(plan['id'])
        self.assertEqual(p['plan_version'],2,p.get('error'))
        self.assertEqual(self.store.get(p['mapping']['T2'])['status'],'queued')
        self.assertEqual(adapter.generate.call_count,3)

    def test_final_escalation_and_human_resume(self):
        runtime, plan, _ = self.setup_plan([self.spec()],[self.worker(),self.review(),self.final('ESCALATE'),self.final()])
        p = self.advance(runtime,plan)
        self.assertEqual(p['status'],'waiting')
        self.assertEqual(p['attention']['kind'],'quality')
        with self.assertRaises(ValueError): runtime.decide(plan['id'],'approve')
        runtime.decide(plan['id'],'resume','Use the original source scope')
        p = self.advance(runtime,plan)
        self.assertEqual(p['status'],'completed',p.get('error'))

    def test_task_and_revision_limits(self):
        for index, limits in enumerate(({'initial_tasks':1,'total_tasks':1},{'revisions':0}),1):
            runtime, plan, _ = self.setup_plan([self.spec(index)],limits=limits)
            change = {'reason':'More','operations':[{'action':'add_task','task':self.spec(index+10)}]}
            with self.assertRaises(ValueError): runtime.apply_change(plan['id'],change)
            self.assertEqual(self.store.get_plan(plan['id'])['plan_version'],1)
            self.assertEqual(len(self.store.tasks()),index)

    def test_completed_task_mutation_and_identity_protection(self):
        runtime, plan, _ = self.setup_plan([self.spec()],[self.worker(),self.review(),self.final()])
        p = self.advance(runtime,plan)
        original = self.store.get(p['tasks'][0])
        for key,value in [('goal','changed'),('depends_on',['other']),('manager_contract',{}),('submission',{}),('manager_approval',{})]:
            task = copy.deepcopy(original); task[key] = value
            with self.assertRaises(ValueError): self.store.save(task,'tamper')
        with self.assertRaises(ValueError): runtime.apply_change(plan['id'],{'reason':'No','operations':[{'action':'add_task','task':self.spec(2)}]})

    def test_restart_preserves_next_task_without_replanning(self):
        runtime, plan, _ = self.setup_plan([self.spec(),self.spec(2,['T1'])],[self.worker(),self.review()])
        for _ in range(3):
            p = runtime.run(plan['id']); t = self.store.get(p['current_task'])
            if t['status'] == 'waiting': runtime.runtime.decide(t['id'],'approve')
        before = runtime.board(plan['id'])
        self.store.close(); self.store = Store(self.vault)
        adapter = Mock(); runtime = PlanRuntime(self.store,Gateway(adapter))
        after = runtime.board(plan['id'])
        self.assertEqual(before['board'],after['board'])
        self.assertEqual(before['plan_change_history'],after['plan_change_history'])
        runtime.run(plan['id'])
        self.assertEqual(adapter.generate.call_count,0)
        self.assertEqual(self.store.get_plan(plan['id'])['current_task'],plan['mapping']['T2'])

    def test_changed_dependency_result_blocks_new_transmission(self):
        runtime, plan, adapter = self.setup_plan([self.spec(),self.spec(2,['T1'])],[self.worker(),self.review()])
        for _ in range(3):
            p = runtime.run(plan['id']); t = self.store.get(p['current_task'])
            if t['status'] == 'waiting': runtime.runtime.decide(t['id'],'approve')
        (self.vault/'results/task1.md').write_text('tampered')
        p = runtime.run(plan['id'])
        self.assertEqual(p['status'],'blocked')
        self.assertIn('dependency output changed',p['error'])
        self.assertEqual(adapter.generate.call_count,2)

    def test_plan_transmission_changes_require_new_approval(self):
        runtime, plan, adapter = self.setup_plan(responses=[self.proposal()])
        first = runtime.run(plan['id'])
        runtime.decide(plan['id'],'approve')
        (self.vault/'notes.md').write_text('Different public source')
        second = runtime.run(plan['id'])
        self.assertEqual(second['status'],'waiting')
        self.assertNotEqual(first['attention']['snapshot'],second['attention']['snapshot'])
        self.assertEqual(adapter.generate.call_count,0)

    def test_known_credentials_rejected_across_roles(self):
        runtime, plan, _ = self.setup_plan()
        with patch.dict(os.environ, {'NIDUS_MODEL_API_KEY':'secret-test-value'}):
            proposal = self.proposal(); proposal['goal'] = 'secret-test-value'
            with self.assertRaises(ValueError): runtime.install(plan,proposal)

    def test_cancelled_dependency_never_ready(self):
        runtime, plan, _ = self.setup_plan([self.spec(),self.spec(2,['T1'])])
        runtime.apply_change(plan['id'],{'reason':'Not needed','operations':[{'action':'cancel_unstarted_task','task':'T1'}]})
        self.assertEqual(runtime.ready([self.store.get(i) for i in plan['tasks']]),[])

    def test_change_rolls_back_new_ids_on_error(self):
        runtime, plan, _ = self.setup_plan([self.spec()])
        duplicate = self.spec(2); duplicate['expected_output'] = 'results/task1.md'
        with self.assertRaises(ValueError):
            runtime.apply_change(plan['id'],{'reason':'Invalid','operations':[{'action':'add_task','task':duplicate}]})
        self.assertEqual(len(self.store.tasks()),1)
        self.assertEqual(self.store.get_plan(plan['id'])['plan_version'],1)

    def test_complete_cannot_skip_unfinished_task(self):
        runtime, plan, _ = self.setup_plan([self.spec(),self.spec(2,['T1'])],[self.worker(['Follow-up']),self.review(),self.final()])
        p = self.advance(runtime,plan)
        self.assertEqual(p['status'],'blocked')
        self.assertEqual(self.store.plans(True),[])

    def test_duplicate_runtime_task_id_rejected(self):
        runtime, plan, _ = self.setup_plan([self.spec()])
        with self.assertRaises(ValueError):
            self.store.submit('Another task',['notes.md'],'other.md','do-now',identity={'id':plan['tasks'][0]})
        self.assertEqual(len(self.store.tasks()),1)

    def test_initial_limit_and_invalid_limits(self):
        runtime, plan, _ = self.setup_plan(limits={'initial_tasks':1})
        with self.assertRaises(ValueError): runtime.install(plan,self.proposal([self.spec(),self.spec(2)]))
        with self.assertRaises(ValueError): runtime.submit('Goal',['notes.md'],default_policy(),limits={'revisions':True})

    def test_atomic_materialization_rolls_back_partial_tasks(self):
        runtime, plan, _ = self.setup_plan()
        self.store.submit('External',['notes.md'],'results/task2.md','do-now')
        with self.assertRaises(ValueError): runtime.install(plan,self.proposal([self.spec(),self.spec(2)]))
        self.assertEqual(plan['tasks'],[])
        self.assertEqual(self.store.get_plan(plan['id'])['tasks'],[])
        self.assertEqual(len(self.store.tasks()),1)

    def test_started_task_cannot_be_cancelled(self):
        runtime, plan, _ = self.setup_plan([self.spec()])
        runtime.run(plan['id'])
        with self.assertRaises(ValueError):
            runtime.apply_change(plan['id'],{'reason':'Cancel','operations':[{'action':'cancel_unstarted_task','task':'T1'}]})

    def test_final_complete_output_tampering_during_model_call(self):
        runtime, plan, adapter = self.setup_plan([self.spec()],[self.worker(),self.review()])
        for _ in range(3):
            p = runtime.run(plan['id']); t = self.store.get(p['current_task'])
            if t['status'] == 'waiting': runtime.runtime.decide(t['id'],'approve')
        runtime.run(plan['id']); runtime.decide(plan['id'],'approve')
        def altered(*args):
            (self.vault/'results/task1.md').write_text('Changed during final review')
            return {'text':json.dumps(self.final()),'finish_reason':'stop','model':'fake'}
        adapter.generate.side_effect = altered
        p = runtime.run(plan['id'])
        self.assertEqual(p['status'],'blocked')
        self.assertEqual(self.store.plans(True),[])

    def test_live_source_mutation_during_planning_invalidates_response(self):
        runtime, plan, adapter = self.setup_plan()
        runtime.run(plan['id']); runtime.decide(plan['id'],'approve')
        def altered(*args):
            (self.vault/'notes.md').write_text('Changed during planning')
            return {'text':json.dumps(self.proposal()),'finish_reason':'stop','model':'fake'}
        adapter.generate.side_effect = altered
        p = runtime.run(plan['id'])
        self.assertEqual(p['status'],'blocked')
        self.assertEqual(self.store.tasks(),[])

    def test_final_add_tasks_revision_limit_stops_expansion(self):
        change = {'reason':'More','operations':[{'action':'add_task','task':self.spec(2)}]}
        runtime, plan, _ = self.setup_plan([self.spec()],[self.worker(),self.review(),self.final('ADD_TASKS',change)],limits={'revisions':0})
        p = self.advance(runtime,plan)
        self.assertEqual(p['status'],'blocked')
        self.assertEqual(len(p['tasks']),1)
        self.assertIn('revision limit',p['error'])

    def test_completed_plan_git_failure_preserves_invalidation_history(self):
        runtime, plan, _ = self.setup_plan([self.spec()],[self.worker(),self.review(),self.final()])
        for _ in range(3):
            p = runtime.run(plan['id']); t = self.store.get(p['current_task'])
            if t['status'] == 'waiting': runtime.runtime.decide(t['id'],'approve')
        runtime.run(plan['id']); runtime.decide(plan['id'],'approve')
        self.store.versioning.checkpoint = Mock(side_effect=ValueError('simulated checkpoint failure'))
        with self.assertRaisesRegex(ValueError,'simulated checkpoint failure'): runtime.run(plan['id'])
        p = self.store.get_plan(plan['id'])
        self.assertEqual(p['status'],'blocked')
        self.assertEqual(p['invalidated_completion']['status'],'completed')
        self.assertIsNone(p['result'])

    def test_adjustment_can_continue_existing_ready_work(self):
        continuation = self.final(); continuation['decision'] = 'CONTINUE'
        runtime, plan, adapter = self.setup_plan([self.spec(),self.spec(2,['T1'])],
            [self.worker(['Confirm next step']),self.review(),continuation,self.worker(),self.review(),self.final()])
        p = self.advance(runtime,plan)
        self.assertEqual(p['status'],'completed',p.get('error'))
        self.assertEqual(p['plan_version'],1)
        self.assertEqual(adapter.generate.call_count,6)
        self.assertTrue(any(e['kind'] == 'plan_continued' for e in self.store.events(plan['id'])))

    def test_cancelled_dependency_stall_requires_manager_escalation(self):
        runtime, plan, _ = self.setup_plan([self.spec(),self.spec(2,['T1'])],[self.final('ESCALATE')])
        runtime.apply_change(plan['id'],{'reason':'Cancel initial step','operations':[{'action':'cancel_unstarted_task','task':'T1'}]})
        p = self.advance(runtime,plan)
        self.assertEqual(p['status'],'waiting')
        self.assertEqual(p['attention']['kind'],'quality')
        self.assertEqual(self.store.get(p['mapping']['T2'])['status'],'queued')
        h = p['plan_change_history'][-1]
        self.assertNotEqual(h['previous_plan_hash'],h['new_plan_hash'])

    def test_original_goal_and_constraints_reach_both_task_roles(self):
        from nidus.gateway import messages_for
        runtime, plan, _ = self.setup_plan([self.spec()])
        task = self.store.get(plan['tasks'][0])
        self.assertEqual(task['parent_request'],plan['original_request'])
        self.assertIn('No invented facts',task['manager_contract']['constraints'])
        for role in ('worker','manager'):
            task['model_role'] = role
            task['review_context'] = {}
            content = json.loads(messages_for(task,[])[1]['content'])
            self.assertEqual(content['original_user_goal'],plan['original_request'])
            self.assertEqual(content['parent_constraints'],plan['contract']['constraints'])
            self.assertNotIn('top_level_contract',content)

    def test_schema_one_vault_migrates_without_losing_task(self):
        task = self.store.submit('Legacy',['notes.md'],'legacy.md','do-now')
        self.store.db.execute('DROP TABLE plans')
        self.store.db.execute('PRAGMA user_version=1')
        self.store.db.commit()
        self.store.close()
        self.store = Store(self.vault)
        self.assertEqual(self.store.get(task['id']),task)
        self.assertEqual(self.store.db.execute('PRAGMA user_version').fetchone()[0],2)
        self.assertEqual(self.store.plans(),[])

    def test_direct_dependency_output_is_approved_source(self):
        second = self.spec(2,['T1']); second['sources'] = ['results/task1.md']
        runtime, plan, _ = self.setup_plan([self.spec(),second],[self.worker(),self.review(),self.worker(),self.review(),self.final()])
        p = self.advance(runtime,plan)
        self.assertEqual(p['status'],'completed',p.get('error'))
        task = self.store.get(p['mapping']['T2'])
        self.assertEqual(task['source_hashes']['results/task1.md'],task['dependency_results'][0]['output_hash'])

    def test_other_task_output_without_dependency_is_denied(self):
        second = self.spec(2); second['sources'] = ['results/task1.md']
        runtime, plan, _ = self.setup_plan()
        with self.assertRaises(ValueError): runtime.install(plan,self.proposal([self.spec(),second]))
        self.assertEqual(self.store.tasks(),[])

    def test_initial_plan_cannot_be_reinstalled_or_changed_before_planning(self):
        runtime, plan, _ = self.setup_plan()
        with self.assertRaises(ValueError): runtime.apply_change(plan['id'],{'reason':'Too soon','operations':[{'action':'add_task','task':self.spec()}]})
        runtime.install(plan,self.proposal())
        with self.assertRaises(ValueError): runtime.install(plan,self.proposal())

    def test_transmission_decision_note_rejects_known_secret(self):
        runtime, plan, _ = self.setup_plan()
        runtime.run(plan['id'])
        with patch.dict(os.environ,{'NIDUS_MODEL_API_KEY':'secret-decision-note'}):
            with self.assertRaises(ValueError): runtime.decide(plan['id'],'approve','secret-decision-note')
        self.assertEqual(self.store.get_plan(plan['id'])['decisions'],[])

    def test_dependency_source_transmits_approved_content_not_envelope(self):
        from nidus.runtime import sources_for
        second = self.spec(2,['T1']); second['sources'] = ['results/task1.md']
        runtime, plan, _ = self.setup_plan([self.spec(),second],[self.worker(),self.review()])
        for _ in range(3):
            p = runtime.run(plan['id']); t = self.store.get(p['current_task'])
            if t['status'] == 'waiting': runtime.runtime.decide(t['id'],'approve')
        runtime.run(plan['id'])
        task = self.store.get(plan['mapping']['T2'])
        records = sources_for(self.store,task)
        self.assertEqual(records[0]['text'],self.worker()['result'])
        self.assertEqual(records[0]['hash'],task['dependency_results'][0]['output_hash'])
        self.assertEqual(records[0]['representation'],'approved_dependency_result')
        self.assertNotIn('Work request',records[0]['text'])

    def test_all_five_change_operations_are_atomic_and_versioned(self):
        runtime, plan, _ = self.setup_plan([self.spec(),self.spec(2,['T1'])])
        change = {'reason':'Revise queued work','operations':[
            {'action':'add_task','task':self.spec(3,['T1'])},
            {'action':'modify_unstarted_task','task':'T2','changes':{'goal':'Revised summary','priority':5}},
            {'action':'add_dependency','task':'T2','depends_on':'T3'},
            {'action':'remove_dependency','task':'T2','depends_on':'T1'},
            {'action':'cancel_unstarted_task','task':'T1'}]}
        p = runtime.apply_change(plan['id'],change)
        task = self.store.get(p['mapping']['T2'])
        self.assertEqual(task['id'],plan['mapping']['T2'])
        self.assertEqual(task['goal'],'Revised summary')
        self.assertEqual(task['manager_contract']['goal'],'Revised summary')
        self.assertEqual(task['priority'],5)
        self.assertEqual(task['depends_on'],[p['mapping']['T3']])
        self.assertEqual(self.store.get(p['mapping']['T1'])['status'],'cancelled')
        self.assertEqual(p['plan_version'],2)
        self.assertEqual(len(p['plan_change_history'][-1]['affected_tasks']),3)

    def test_cycle_change_rolls_back_all_operations_and_events(self):
        runtime, plan, _ = self.setup_plan([self.spec(),self.spec(2,['T1'])])
        history = self.store.events(plan['id'])
        with self.assertRaises(ValueError):
            runtime.apply_change(plan['id'],{'reason':'Invalid cycle','operations':[
                {'action':'modify_unstarted_task','task':'T2','changes':{'goal':'Should roll back'}},
                {'action':'add_dependency','task':'T1','depends_on':'T2'}]})
        self.assertEqual(self.store.get_plan(plan['id'])['plan_version'],1)
        self.assertEqual(self.store.get(plan['mapping']['T2'])['goal'],self.spec()['goal'])
        self.assertEqual(self.store.events(plan['id']),history)

    def test_mutations_cannot_target_started_or_completed_tasks(self):
        runtime, plan, _ = self.setup_plan([self.spec(),self.spec(2)])
        runtime.run(plan['id'])
        for op in (
            {'action':'modify_unstarted_task','task':'T1','changes':{'title':'Changed'}},
            {'action':'add_dependency','task':'T1','depends_on':'T2'},
            {'action':'cancel_unstarted_task','task':'T1'}):
            with self.assertRaises(ValueError): runtime.apply_change(plan['id'],{'reason':'No','operations':[op]})

    def test_modified_sources_revalidate_dependencies_and_output_ownership(self):
        runtime, plan, _ = self.setup_plan([self.spec(),self.spec(2,['T1'])])
        for changes in ({'local_key':'T9'},{'sources':['private.md']},{'expected_output':'results/task1.md'}):
            with self.assertRaises(ValueError): runtime.apply_change(plan['id'],{'reason':'No','operations':[
                {'action':'modify_unstarted_task','task':'T2','changes':changes}]})
        # Moving an unstarted output frees that path within this atomic graph revision.
        p = runtime.apply_change(plan['id'],{'reason':'Move output','operations':[
            {'action':'modify_unstarted_task','task':'T1','changes':{'expected_output':'moved.md'}},
            {'action':'add_task','task':dict(self.spec(3),expected_output='results/task1.md')}]})
        self.assertEqual(self.store.get(p['mapping']['T1'])['output'],'moved.md')

    def test_result_snapshot_is_rechecked_before_task_review(self):
        second=self.spec(2,['T1']);second['sources']=['results/task1.md']
        runtime, plan, adapter = self.setup_plan([self.spec(),second],[self.worker(),self.review(),self.worker()])
        for _ in range(5):
            p=runtime.run(plan['id']);t=self.store.get(p['current_task'])
            if t['status']=='waiting': runtime.runtime.decide(t['id'],'approve')
        (self.vault/'results/task1.md').write_text('changed after worker')
        p=runtime.run(plan['id'])
        self.assertEqual(p['status'],'blocked')
        self.assertEqual(adapter.generate.call_count,3)

    def test_role_policy_selection_and_cross_role_secret_boundary(self):
        from nidus.gateway import messages_for, transmission
        final_policy=default_policy()
        final_policy['routes'][0]['api_key_env']='NIDUS_FINAL_TEST_API_KEY'
        runtime=PlanRuntime(self.store)
        plan=runtime.submit('Report',['notes.md'],default_policy(),final_policy=final_policy)
        runtime.install(plan,self.proposal())
        self.assertEqual(runtime.call(plan,'final_review')['model_policy']['routes'][0]['api_key_env'],'NIDUS_FINAL_TEST_API_KEY')
        self.assertNotEqual(runtime.call(plan,'planning')['model_policy'],runtime.call(plan,'final_review')['model_policy'])
        task=self.store.get(plan['tasks'][0])
        with patch.dict(os.environ,{'NIDUS_FINAL_TEST_API_KEY':'cross-role-secret'}):
            with self.assertRaises(ValueError): transmission(task,[{'path':'notes.md','hash':'hash','text':'cross-role-secret'}])

    def test_cached_final_generation_restart_requires_no_model_recall(self):
        runtime,plan,adapter=self.setup_plan([self.spec()],[self.worker(),self.review(),self.final()])
        for _ in range(3):
            p=runtime.run(plan['id']);t=self.store.get(p['current_task'])
            if t['status']=='waiting': runtime.runtime.decide(t['id'],'approve')
        runtime.run(plan['id']);runtime.decide(plan['id'],'approve')
        with self.store.lock():
            p=self.store.get_plan(plan['id'])
            value,_=runtime.model(p,'final_review')
            self.assertEqual(value['decision'],'COMPLETE')
        calls=adapter.generate.call_count
        self.store.close();self.store=Store(self.vault)
        restarted=PlanRuntime(self.store,Gateway(adapter))
        self.assertEqual(restarted.run(plan['id'])['status'],'completed')
        self.assertEqual(adapter.generate.call_count,calls)

    def test_manager_can_repair_stalled_graph_without_extra_task(self):
        change={'reason':'Dependency no longer required','operations':[
            {'action':'remove_dependency','task':'T2','depends_on':'T1'}]}
        adjustment=self.final('ADD_TASKS',change);adjustment['decision']='CHANGE_PLAN'
        runtime,plan,adapter=self.setup_plan([self.spec(),self.spec(2,['T1'])],
            [adjustment,self.worker(),self.review(),self.final()])
        runtime.apply_change(plan['id'],{'reason':'Cancel unused work','operations':[
            {'action':'cancel_unstarted_task','task':'T1'}]})
        p=self.advance(runtime,plan)
        self.assertEqual(p['status'],'completed',p.get('error'))
        self.assertEqual(len(p['tasks']),2)
        self.assertEqual(p['plan_version'],3)
        self.assertEqual(adapter.generate.call_count,4)
