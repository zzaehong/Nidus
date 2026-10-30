import json, pathlib, tempfile, threading, unittest
from manager_probe import recovered_stop, require_stopped, begin_run

class RecoveryTests(unittest.TestCase):
    def test_missing_corrupt_wrong_run_and_requested_only(self):
        with tempfile.TemporaryDirectory() as d:
            p=pathlib.Path(d)/'events'
            for data in (None,'broken',json.dumps({'runID':'other','action':'stop-confirmed','actualState':0}),json.dumps({'runID':'run','action':'termination-request','actualState':1}),json.dumps({'runID':'run','action':'forceStop-failed','actualState':1}),json.dumps({'runID':'run','action':'stop-unconfirmed','actualState':0})):
                if data is not None:p.write_text(data)
                for operation in ('apply','cleanup','new-execution'):
                    with self.assertRaises(ValueError):require_stopped(p,'run',operation)
    def test_admission_persisted_before_launch(self):
        with tempfile.TemporaryDirectory() as d:
            registry=pathlib.Path(d)/'registry';journal=pathlib.Path(d)/'events'
            registry.write_text('null');begin_run(registry,journal,'one')
            with self.assertRaises(ValueError):begin_run(registry,journal,'two')
            journal.write_text(json.dumps({'runID':'one','action':'stop-confirmed','actualState':0}))
            begin_run(registry,journal,'two')
            registry.write_text('{')
            with self.assertRaises(ValueError):begin_run(registry,journal,'three')

    def test_concurrent_admission_only_one_wins(self):
        with tempfile.TemporaryDirectory() as d:
            registry=pathlib.Path(d)/'registry';registry.write_text('null')
            barrier=threading.Barrier(2);results=[]
            def launch(run):
                barrier.wait()
                try:begin_run(registry,pathlib.Path(d)/run,run);results.append(True)
                except ValueError:results.append(False)
            threads=[threading.Thread(target=launch,args=(run,)) for run in ('one','two')]
            for thread in threads:thread.start()
            for thread in threads:thread.join()
            self.assertEqual(sorted(results),[False,True])

    def test_only_confirmed_terminal_state_allows(self):
        with tempfile.TemporaryDirectory() as d:
            p=pathlib.Path(d)/'events'
            for state in (0,1):
                p.write_text(json.dumps({'runID':'run','action':'stop-confirmed','actualState':state}))
                self.assertEqual(recovered_stop(p,'run'),state==0)
            p.write_text(json.dumps({'runID':'run','action':'stop-confirmed','actualState':0})+'\n{')
            self.assertFalse(recovered_stop(p,'run'))

if __name__=='__main__':unittest.main()
