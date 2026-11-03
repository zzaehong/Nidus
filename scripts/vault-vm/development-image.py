"""Explicit official-package lock/update/build. No downloaded installation scripts execute on Host."""
import argparse, pathlib, tarfile, hashlib, json, re, urllib.request, concurrent.futures, os, shutil
BASE='https://dl-cdn.alpinelinux.org/alpine/v3.24/'
ROOTS=['python3','py3-pip','nodejs','npm','git','bash','curl','build-base','chromium','ca-certificates-bundle']
def sha(p):
 h=hashlib.sha256()
 with open(p,'rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()
def fetch(url,path):
 if not url.startswith(BASE):raise ValueError('untrusted package URL')
 with urllib.request.urlopen(url,timeout=90) as response,open(str(path)+'.part','wb') as out:shutil.copyfileobj(response,out)
 os.replace(str(path)+'.part',path)
def update(cache,lock):
 entries={};indexes={}
 for repo in ['main','community']:
  path=cache/(repo+'-index.tar.gz');fetch(BASE+repo+'/aarch64/APKINDEX.tar.gz',path);indexes[repo]=sha(path)
  with tarfile.open(path) as t:data=t.extractfile('APKINDEX').read().decode()
  for block in data.split('\n\n'):
   e=dict(line.split(':',1) for line in block.splitlines() if ':' in line)
   if 'P' in e:e['repo']=repo;entries[e['P']]=e
 provided={}
 def name(s):return re.split('[=<>~]',s)[0]
 for e in entries.values():
  for p in e.get('p','').split():provided.setdefault(name(p),[]).append(e['P'])
 selected={}
 def add(n):
  if n.startswith('!'):return
  n=name(n)
  n={'/bin/sh':'busybox-binsh','libc-dev':'musl-dev','icu-data':'icu-data-full','so:libisl.so.23':'isl26','so:libudev.so.1':'eudev-libs'}.get(n,n)
  if n not in entries:
   candidates=provided.get(n,[])
   if len(candidates)!=1:raise ValueError('ambiguous/missing dependency '+n+': '+str(candidates))
   n=candidates[0]
  if n in selected:return
  e=entries[n];selected[n]=e
  for dep in e.get('D','').split():add(dep)
 for n in ROOTS:add(n)
 def package(e):
  filename=e['P']+'-'+e['V']+'.apk';url=BASE+e['repo']+'/aarch64/'+filename;path=cache/filename
  fetch(url,path)
  return {'name':e['P'],'version':e['V'],'url':url,'sha256':sha(path),'bytes':path.stat().st_size,'license':e.get('L',''),'dependencies':e.get('D','')}
 with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:packages=list(pool.map(package,sorted(selected.values(),key=lambda e:e['P'])))
 lock.write_text(json.dumps({'schemaVersion':1,'architecture':'aarch64','distribution':'Alpine 3.24','requested':ROOTS,'indexesSHA256':indexes,'packages':packages},indent=2)+'\n')
 print('Locked',len(packages),'official packages; bytes',sum(p['bytes'] for p in packages))
def build(cache,lock,destination):
 data=json.loads(lock.read_text());destination.mkdir(parents=True,exist_ok=False)
 for package in data['packages']:
  path=cache/(package['name']+'-'+package['version']+'.apk')
  if not path.exists():fetch(package['url'],path)
  if sha(path)!=package['sha256']:raise ValueError('package digest mismatch: '+path.name)
  with tarfile.open(path,'r:gz',ignore_zeros=True) as archive:
   for item in archive:
    parts=pathlib.PurePosixPath(item.name).parts
    if not parts or parts[0].startswith('.'):continue
    if item.name.startswith('/') or '..' in parts:raise ValueError('unsafe archive path')
    target=destination.joinpath(*parts)
    if not target.parent.resolve().is_relative_to(destination.resolve()):raise ValueError('archive parent escape')
    if item.isdir():target.mkdir(parents=True,exist_ok=True);continue
    target.parent.mkdir(parents=True,exist_ok=True)
    if target.is_symlink() or target.exists():
     if target.is_dir():raise ValueError('archive object conflict')
     target.unlink()
    if item.issym():
     link=item.linkname
     if link.startswith('/'):link=os.path.relpath(destination/link.lstrip('/'),target.parent)
     if not (target.parent/link).resolve().is_relative_to(destination.resolve()):raise ValueError('archive link escape')
     target.symlink_to(link)
    elif item.isfile():
     with archive.extractfile(item) as src,open(target,'wb') as out:shutil.copyfileobj(src,out)
     target.chmod(item.mode&0o755) # Strip setuid/setgid from the managed development layer.
    elif item.islnk():
     source=destination/item.linkname
     if not source.resolve().is_relative_to(destination.resolve()) or not source.is_file():raise ValueError('archive hardlink')
     shutil.copyfile(source,target);target.chmod(item.mode&0o755)
    else:raise ValueError('unsupported package entry')
 (destination/'nidus-packages.json').write_text(json.dumps(data,sort_keys=True))
 print('Development root built without running package scripts')
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('operation',choices=['lock','build']);parser.add_argument('cache',type=pathlib.Path);parser.add_argument('--lock',type=pathlib.Path,default=pathlib.Path(__file__).with_name('development.lock.json'));parser.add_argument('--output',type=pathlib.Path)
 args=parser.parse_args();args.cache.mkdir(parents=True,exist_ok=True)
 if args.operation=='lock':update(args.cache,args.lock)
 else:build(args.cache,args.lock,args.output)
