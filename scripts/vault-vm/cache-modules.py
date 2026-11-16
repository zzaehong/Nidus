"""Add only ext4 and dependencies from a pinned package matching the existing boot kernel."""
import pathlib,json,hashlib,tarfile

def install(package,root,kernel_digest):
 lock=json.loads(pathlib.Path(__file__).with_name('cache-kernel.lock.json').read_text())
 h=hashlib.sha256()
 with open(package,'rb') as f:
  for b in iter(lambda:f.read(1048576),b''):h.update(b)
 if h.hexdigest()!=lock['sha256']:raise ValueError('cache kernel package digest')
 release=lock['release']
 with tarfile.open(package,'r:gz',ignore_zeros=True) as archive:
  members={m.name.lstrip('./'):m for m in archive if m.isfile()}
  kernels=[m for n,m in members.items() if n=='boot/vmlinuz-virt']
  if len(kernels)!=1 or hashlib.sha256(archive.extractfile(kernels[0]).read()).hexdigest()!=kernel_digest:raise ValueError('cache modules do not match pinned boot kernel')
  deps=[n for n in members if n.endswith('/'+release+'/modules.dep')]
  if len(deps)!=1:raise ValueError('cache module dependency index')
  prefix=deps[0][:-len('modules.dep')]
  text=archive.extractfile(members[deps[0]]).read().decode()
  graph={line.split(':',1)[0]:line.split(':',1)[1].split() for line in text.splitlines() if ':' in line}
  selected=set()
  def add(name):
   if name in selected:return
   if name.startswith('/') or '..' in pathlib.PurePosixPath(name).parts:raise ValueError('module traversal')
   selected.add(name)
   for dep in graph[name]:add(dep)
  choices=[n for n in graph if n in ['kernel/fs/ext4/ext4.ko','kernel/fs/ext4/ext4.ko.gz']]
  if len(choices)!=1:raise ValueError('unsupported ext4 module format')
  add(choices[0])
  destination=root/'usr/lib/modules'/release
  for name in selected:
   member=members[prefix+name];target=destination/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(archive.extractfile(member).read());target.chmod(0o644)
  depfile=destination/'modules.dep'
  original=depfile.read_text()
  depfile.write_text(original+'\n'+'\n'.join(n+': '+' '.join(graph[n]) for n in sorted(selected))+'\n')
 return sorted(selected)
