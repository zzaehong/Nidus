import json,pathlib,tempfile,unittest
from lifecycle import reconcile

class LifecycleTests(unittest.TestCase):
    def check(self,events,live=None,restarting=True):
        with tempfile.TemporaryDirectory() as d:
            p=pathlib.Path(d)/'journal'
            p.write_text('\n'.join(json.dumps({'runID':'r','action':action,'actualState':state}) for action,state in events))
            return reconcile(p,'r',live,restarting)
    def test_live_states(self):
        for action,state,want in [('manager-ready',0,'CREATED'),('start-request',0,'STARTING'),('start-completed',1,'RUNNING'),('termination-request',1,'STOP_REQUESTED'),('failed',3,'FAILED'),('stop-unconfirmed',1,'STOP_UNCONFIRMED')]:
            self.assertEqual(self.check([(action,state)],restarting=False)['state'],want)
    def test_restart_never_promotes_live_or_failed(self):
        for action in ('manager-ready','start-request','start-completed','termination-request','failed'):
            result=self.check([(action,0)])
            self.assertEqual(result['state'],'STOP_UNCONFIRMED');self.assertFalse(result['allowOperations'])
    def test_matching_callback_and_state_required(self):
        proof=[('forceStop-completed',0),('stop-confirmed',0)]
        self.assertTrue(self.check(proof)['allowOperations'])
        self.assertFalse(self.check([('stop-confirmed',0)])['allowOperations'])
        self.assertFalse(self.check(proof,live=1)['allowOperations'])
        self.assertFalse(self.check(proof+[('status',1)])['allowOperations'])
        self.assertFalse(self.check([('stop-unconfirmed',1)]+proof)['allowOperations'])
    def test_malformed_json_shapes(self):
        with tempfile.TemporaryDirectory() as d:
            p=pathlib.Path(d)/'j'
            for text in ('null','[]','42','{}','{',''):
                p.write_text(text);self.assertFalse(reconcile(p,'r')['allowOperations'])

if __name__=='__main__':unittest.main()
