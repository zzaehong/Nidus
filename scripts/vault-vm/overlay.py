"""Refresh trusted supervisors on an explicitly supplied, hash-verified development image.
No downloads or Host execution of guest code. Original assets are never changed.
"""
import pathlib,sys,json,hashlib,tempfile,shutil
from newc import write
source=pathlib.Path(sys.argv[1]).resolve();destination=pathlib.Path(sys.argv[2]).resolve()
if source==destination:raise ValueError('distinct output directory required')
manifest=json.loads((source/'manifest.json').read_text())
if manifest.get('profile')!='development':raise ValueError('development image required')
def digest(path):
 h=hashlib.sha256()
 with open(path,'rb') as f:
  for chunk in iter(lambda:f.read(1048576),b''):h.update(chunk)
 return h.hexdigest()
for name in ['Image','initrd']:
 if digest(source/name)!=manifest[name]:raise ValueError('source digest mismatch')
destination.mkdir(parents=True,exist_ok=False)
with tempfile.TemporaryDirectory() as staging:
 root=pathlib.Path(staging);helpers=root/'opt/development/nidus';helpers.mkdir(parents=True)
 scripts=pathlib.Path(__file__).parent
 shutil.copyfile(scripts/'init.sh',root/'init');(root/'init').chmod(0o755)
 for name in ['session.py','child.py','workspace.py']:shutil.copyfile(scripts/name,helpers/name)
 browser=root/'opt/development/usr/lib/nidus';browser.mkdir(parents=True)
 shutil.copyfile(scripts/'browser.mjs',browser/'browser.mjs')
 shutil.copyfile(scripts/'browser-live.mjs',browser/'browser-live.mjs')
 shutil.copyfile(scripts/'browser-dom.mjs',browser/'browser-dom.mjs')
 # Write outside the input tree so the archive never includes its own output.
 with tempfile.NamedTemporaryFile() as archive:
  write(root,archive.name)
  with open(destination/'initrd','wb') as out:
   for path in [source/'initrd',pathlib.Path(archive.name)]:
    with open(path,'rb') as data:shutil.copyfileobj(data,out,1048576)
shutil.copyfile(source/'Image',destination/'Image')
manifest['baseInitrdSHA256']=manifest['initrd'];manifest['initrd']=digest(destination/'initrd');manifest['browserSnapshotVersion']=1
manifest['browserInteractiveVersion']=1
(destination/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
