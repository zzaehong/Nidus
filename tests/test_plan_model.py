import copy
import unittest
import test_runtime
from nidus.plan_model import identifier, strict_object, validate_graph, ready_tasks
from nidus.store import Store


class PlanModelTests(unittest.TestCase):
    setUp = test_runtime.RuntimeTests.setUp
    tearDown = test_runtime.RuntimeTests.tearDown

    def spec(self,n=1,deps=None):
        return {'local_key':'T'+str(n),'title':'Task','goal':'Summarize','priority':1,
            'depends_on':deps or [],'sources':['notes.md'],'completion_criteria':['Grounded'],
            'expected_output':'result'+str(n)+'.md'}

    def test_traceable_unique_ids(self):
        plan = identifier('pln')
        task = identifier('tsk','manager-1',plan,3)
        self.assertIn(plan.rsplit('_',1)[-1],task)
        self.assertIn('_manager1_',task)
        self.assertIn('_003_',task)
        self.assertEqual(len({identifier('tsk','manager-1',plan,i) for i in range(1000)}),1000)

    def test_dag_and_invalid_proposals(self):
        validate_graph(self.store,[self.spec(),self.spec(2,['T1'])],['notes.md'],10)
        cases = [[self.spec(1,['T1'])],[self.spec(1,['T9'])],
            [self.spec(1,['T2']),self.spec(2,['T1'])],[self.spec(),self.spec()]]
        for field,value in [('goal',''),('priority',True),('priority','1'),('completion_criteria',[]),
            ('sources',['../outside.md']),('expected_output','notes.md')]:
            spec=self.spec();spec[field]=value;cases.append([spec])
        for specs in cases:
            with self.assertRaises(ValueError): validate_graph(self.store,specs,['notes.md'],10)
        with self.assertRaises(ValueError): validate_graph(self.store,[self.spec(),self.spec(2)],['notes.md'],1)

    def test_dependency_output_requires_direct_dependency(self):
        second=self.spec(2,['T1']);second['sources']=['result1.md']
        validate_graph(self.store,[self.spec(),second],['notes.md'],10)
        second['depends_on']=[]
        with self.assertRaises(ValueError): validate_graph(self.store,[self.spec(),second],['notes.md'],10)

    def test_ready_priority_and_all_dependency_states(self):
        tasks=[dict(id='T'+str(i),priority=priority,sequence=i,created_at='now',status='queued',depends_on=deps)
            for i,priority,deps in ((1,2,[]),(2,1,[]),(3,1,['T1','T2']))]
        self.assertEqual(ready_tasks(tasks),['T2','T1'])
        tasks[0]['status']='completed'
        for status in ('queued','blocked','cancelled','waiting'):
            tasks[1]['status']=status;self.assertNotIn('T3',ready_tasks(tasks))
        tasks[1]['status']='completed';self.assertEqual(ready_tasks(tasks),['T3'])

    def test_strict_json(self):
        for text in ('```json\n{}\n```','{"a":1,"a":2}','{"a":NaN}','[]','{} trailing'):
            with self.assertRaises(ValueError): strict_object(text)

    def test_plan_persistence_uniqueness_and_transaction(self):
        plan={'id':identifier('pln'),'status':'planning'}
        self.store.save_plan(plan,'submitted',create=True)
        with self.assertRaises(ValueError): self.store.save_plan(plan,'submitted',create=True)
        with self.assertRaises(ValueError):
            with self.store.transaction():
                self.store.submit('Task',['notes.md'],'result.md','do-now')
                raise ValueError('rollback')
        self.assertEqual(self.store.tasks(),[])
        self.store.close();self.store=Store(self.vault)
        self.assertEqual(self.store.get_plan(plan['id']),plan)

    def test_schema_one_migration_and_completed_protection(self):
        task=self.store.submit('Task',['notes.md'],'result.md','do-now')
        self.store.db.execute('DROP TABLE plans');self.store.db.execute('PRAGMA user_version=1');self.store.db.commit()
        self.store.close();self.store=Store(self.vault)
        self.assertEqual(self.store.get(task['id']),task)
        self.assertEqual(self.store.db.execute('PRAGMA user_version').fetchone()[0],2)
        from nidus.runtime import Runtime
        completed=Runtime(self.store).run(task['id'])
        modified=copy.deepcopy(completed);modified['request']='changed'
        with self.assertRaises(ValueError): self.store.save(modified,'tamper')
        with self.assertRaises(ValueError):
            self.store.submit('Duplicate',['notes.md'],'other.md','do-now',identity={'id':task['id']})
