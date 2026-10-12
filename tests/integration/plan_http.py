"""Separate-process Plan CLI and real loopback HTTP, no external models."""
import json
import unittest
import model_http


class PlanHttp(unittest.TestCase):
    setUp = model_http.HttpIntegration.setUp
    tearDown = model_http.HttpIntegration.tearDown
    cli = model_http.HttpIntegration.cli

    def spec(self, n, deps):
        return {'local_key':'T'+str(n),'title':'Task '+str(n),'goal':'Summarize Nidus',
            'priority':1,'depends_on':deps,'sources':['notes.md'],
            'completion_criteria':['Source supported'],'expected_output':'result'+str(n)+'.md'}

    def proposal(self):
        return {'goal':'Supported report','scope':'Selected source','completion_criteria':['Supported report'],
            'constraints':['No invented facts'],'expected_result':'Report',
            'human_judgment_conditions':['Insufficient evidence'],'planning_reason':'Two steps',
            'tasks':[self.spec(1,[]),self.spec(2,['T1'])]}

    def prepare(self, values):
        self.server.plan_responses = [json.dumps(v) for v in values]
        plan = self.cli('plan-submit','Supported report','--source','notes.md','--model-policy',str(self.policy))
        first = self.cli('plan-run',plan['id'])
        self.assertEqual(first['attention']['kind'],'transmission')
        self.assertEqual(len(self.server.calls),0)
        self.cli('plan-decide',plan['id'],'approve')
        return plan

    def test_two_tasks_restart_final_and_archive(self):
        criteria = [{'criterion_id':'C1','status':'satisfied','reason':'Source checked'}]
        worker = {'result':'Nidus sample facts.','self_check':criteria,'questions':[],'known_limitations':[]}
        review = {'decision':'APPROVE','criteria':criteria,'reason':'Supported','issues':[],'instructions':[],'questions':[]}
        final = {'decision':'COMPLETE','criteria':criteria,'reason':'Goal satisfied','questions':[],'change':None}
        plan = self.prepare([self.proposal(),worker,review,worker,review,final])
        for _ in range(20):
            current = self.cli('plan-run',plan['id'])
            if current['status'] == 'completed': break
            self.assertNotEqual(current['status'],'blocked',current.get('error'))
            if current['status'] == 'waiting': self.cli('plan-decide',plan['id'],'approve')
            for tid in current['tasks']:
                task = self.cli('show',tid)
                if task['status'] == 'waiting': self.cli('decide',tid,'approve')
        self.assertEqual(current['status'],'completed')
        self.assertEqual(len(self.server.calls),6)
        self.assertEqual(self.cli('plan-list'),[])
        self.assertEqual(len(self.cli('plan-list','--archive')),1)
        board = self.cli('plan-show',plan['id'])['board']
        self.assertEqual([t['status'] for t in board],['completed','completed'])
        t2 = self.cli('show',board[1]['id'])
        self.assertEqual(t2['dependency_results'][0]['task_id'],board[0]['id'])
        self.assertEqual(self.cli('plan-run',plan['id'])['status'],'completed')
        self.assertEqual(len(self.server.calls),6)

    def test_malformed_planning_never_creates_tasks(self):
        plan = self.prepare([self.proposal()])
        self.server.plan_responses = ['```json\n'+json.dumps(self.proposal())+'\n```']
        result = self.cli('plan-run',plan['id'],code=2)
        self.assertEqual(result['status'],'blocked')
        self.assertEqual(self.cli('list'),[])
        self.assertEqual(self.cli('plan-list','--archive'),[])


if __name__ == '__main__':
    unittest.main()
