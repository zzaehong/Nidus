import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch
from workspace import *
from probe import termination_verdict

class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='nidus-workspace-',dir='/private/tmp')
        self.root=pathlib.Path(self.temp.name);self.vault=self.root/'vault';self.ws=self.root/'workspace'
        self.vault.mkdir();self.ws.mkdir();(self.vault/'input.txt').write_bytes(b'approved')
    def tearDown(self): self.temp.cleanup()
    def test_termination_verdict_never_confuses_quiet_with_confirmed_stop(self):
        self.assertEqual(termination_verdict(False,False,True),'NOT_RUN')
        self.assertEqual(termination_verdict(True,True,True),'FAIL')
        self.assertEqual(termination_verdict(True,False,False),'NOT_RUN')
        self.assertEqual(termination_verdict(True,False,True),'PASS')
    def test_approved_copy_and_separate_apply(self):
        export_file(self.vault,self.ws,'input.txt',digest(b'approved'))
        self.assertEqual(read_file(self.ws,'input.txt'),b'approved')
        (self.ws/'result.txt').write_text('result\n');review=proposal(self.ws,'result.txt')
        self.assertIn('+result',review['diff'])
        for approved,stopped in [(False,True),(True,False)]:
            with self.assertRaises(ValueError): apply_new_file(self.ws,self.vault,review,approved,stopped)
        self.assertFalse((self.vault/'result.txt').exists())
        apply_new_file(self.ws,self.vault,review,True,True)
        with self.assertRaises(FileExistsError): apply_new_file(self.ws,self.vault,review,True,True)
    def test_links_and_paths(self):
        for name in ['../input.txt','/input.txt','.nidus','.git','.env','keychain.db','secret.txt','id_rsa','project.env','client.pfx','nested/file']:
            with self.assertRaises(ValueError): export_file(self.vault,self.ws,name,digest(b'approved'))
        (self.vault/'sym.txt').symlink_to(self.vault/'input.txt')
        with self.assertRaises(OSError): read_file(self.vault,'sym.txt')
        os.link(self.vault/'input.txt',self.vault/'hard.txt')
        with self.assertRaises(ValueError): read_file(self.vault,'hard.txt')
        (self.root/'alias').symlink_to(self.vault)
        with self.assertRaises(OSError): read_file(self.root/'alias','input.txt')
    def test_changed_approval_and_output(self):
        with self.assertRaises(ValueError): export_file(self.vault,self.ws,'input.txt',digest(b'old'))
        (self.ws/'result.txt').write_text('before');review=proposal(self.ws,'result.txt')
        (self.ws/'result.txt').write_text('after')
        with self.assertRaises(ValueError): apply_new_file(self.ws,self.vault,review,True,True)
    def test_replacement_during_read(self):
        original=os.read;replaced=False
        def replace(fd,size):
            nonlocal replaced
            data=original(fd,size)
            if not replaced:
                replaced=True
                (self.vault/'replacement').write_bytes(b'unapproved')
                os.replace(self.vault/'replacement',self.vault/'input.txt')
            return data
        with patch('workspace.os.read',replace):
            with self.assertRaises(ValueError): read_file(self.vault,'input.txt')
    def test_destination_race_cannot_overwrite(self):
        (self.ws/'result.txt').write_text('approved');review=proposal(self.ws,'result.txt')
        (self.vault/'result.txt').symlink_to(self.vault/'input.txt')
        with self.assertRaises(FileExistsError): apply_new_file(self.ws,self.vault,review,True,True)
        self.assertEqual((self.vault/'input.txt').read_bytes(),b'approved')

if __name__=='__main__':unittest.main()
