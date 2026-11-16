import hashlib,json,pathlib,tempfile,unittest,uuid
from unittest.mock import patch
from recovery import snapshot,restart_proof

class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.temp.name).resolve()
        self.registry=self.root/'registry';self.journal=self.root/'events.jsonl';self.run=str(uuid.uuid4())
        self.record={'runID':self.run,'journal':str(self.journal),'bootID':str(uuid.uuid4())}
        self.journal.write_text(json.dumps({'runID':self.run,'action':'start-completed','actualState':1})+'\n')
        self.registry.write_text(json.dumps(self.record))
    def tearDown(self):self.temp.cleanup()
    def test_missing_channel_keeps_lock_and_records_detection(self):
        value=snapshot(self.registry);self.assertTrue(value['locked']);self.assertFalse(value['canStop']);self.assertIsNotNone(value['faultDetectedAt'])
        again=snapshot(self.registry,'cancel');self.assertTrue(again['locked']);self.assertEqual(len(again['recoveryAttempts']),1)
    def test_corrupt_journal_and_no_secret_display(self):
        self.journal.write_text('API_KEY_SECRET')
        value=snapshot(self.registry);self.assertTrue(value['locked']);self.assertNotIn('API_KEY_SECRET',json.dumps(value))
    def test_boot_and_integrity_are_independent_requirements(self):
        inventory={}
        for group in ('original','workspace'):
            directory=self.root/group;directory.mkdir();(directory/'file.txt').write_text('known')
            inventory[group]={'path':str(directory),'hashes':{'file.txt':hashlib.sha256(b'known').hexdigest()}}
        self.record['integrity']=inventory
        self.assertFalse(restart_proof(self.record,None))
        self.assertFalse(restart_proof(self.record,self.record['bootID']))
        new_boot=str(uuid.uuid4());self.assertTrue(restart_proof(self.record,new_boot))
        self.record['registryIdentity']=[self.registry.stat().st_dev,self.registry.stat().st_ino]
        self.registry.write_text(json.dumps(self.record))
        with patch('recovery.boot_id',return_value=new_boot):self.assertFalse(snapshot(self.registry)['locked'])
        (self.root/'original/file.txt').write_text('unapproved')
        with patch('recovery.boot_id',return_value=new_boot):self.assertTrue(snapshot(self.registry)['locked'])
    def test_corrupt_audit_cannot_unlock(self):
        (self.root/'recovery-events.jsonl').write_text('{')
        value=snapshot(self.registry);self.assertTrue(value['locked']);self.assertFalse(value['canStop'])
    def test_registry_copy_cannot_claim_reboot_release(self):
        self.record['registryIdentity']=[0,0]
        self.registry.write_text(json.dumps(self.record))
        with patch('recovery.boot_id',return_value=str(uuid.uuid4())),patch('recovery.integrity',return_value=True):
            self.assertTrue(snapshot(self.registry)['locked'])

    def test_boot_without_inventory_never_unlocks(self):
        with patch('recovery.boot_id',return_value=str(uuid.uuid4())):self.assertTrue(snapshot(self.registry)['locked'])
    def test_mismatch_and_failed_control(self):
        with patch('recovery.control',side_effect=OSError()):self.assertFalse(snapshot(self.registry,'cancel')['canStop'])
        self.journal.write_text('\n'.join(json.dumps({'runID':self.run,'action':a,'actualState':0}) for a in ('forceStop-completed','stop-confirmed')))
        with patch('recovery.control',return_value={'actualState':1,'canStop':False}):self.assertTrue(snapshot(self.registry)['locked'])

if __name__=='__main__':unittest.main()
