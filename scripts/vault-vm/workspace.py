"""Root-only bounded staging protocol; no Host paths or writable Host mounts."""
import pathlib,sys,uuid,base64,hashlib,json,os,stat
BASE=pathlib.Path('/run/workspace')
def identity(value):
 if str(uuid.UUID(value))!=value:raise ValueError('snapshot identity')
 return value
def validate(data):
 if data.get('schemaVersion')!=1:raise ValueError('snapshot schema')
 identity(data['snapshotId']);identity(data['vaultId']);identity(data['environmentId'])
 files=data['files'];seen=set();total=0
 if not isinstance(files,list) or not 1<=len(files)<=32:raise ValueError('file count')
 for f in files:
  path=f['path'];parts=pathlib.PurePosixPath(path).parts
  if not parts or path.startswith('/') or '\\' in path or any(p.startswith('.') or any(ord(c)<32 for c in p) for p in parts) or '/'.join(parts)!=path or path in seen:raise ValueError('snapshot path')
  seen.add(path);raw=f['content'].encode('utf8');total+=len(raw)
  if b'\0' in raw or len(raw)>65536 or total>524288 or hashlib.sha256(raw).hexdigest()!=f['hash']:raise ValueError('snapshot content')
 return data

def load(value):
 path=BASE/(identity(value)+'.json')
 data=validate(json.loads(path.read_text()));path.unlink();return data

def export(root,data):
 output=[];total=0
 for f in data['files']:
  path=root/'work'/f['path'];cursor=root/'work'
  for part in pathlib.PurePosixPath(f['path']).parts[:-1]:
   cursor/=part
   if cursor.is_symlink() or not cursor.is_dir():raise ValueError('workspace parent changed')
  try:info=path.lstat()
  except FileNotFoundError:output.append({'path':f['path'],'content':None});continue
  if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>65536:raise ValueError('workspace unsafe result')
  raw=path.read_bytes();total+=len(raw)
  if total>524288:raise ValueError('workspace result total')
  if b'\0' in raw:raise ValueError('workspace binary result')
  output.append({'path':f['path'],'content':raw.decode('utf8')})
 return output

if __name__=='__main__':
 action,value,payload=sys.argv[1:];value=identity(value);BASE.mkdir(mode=0o700,exist_ok=True);partial=BASE/(value+'.part');sealed=BASE/(value+'.json')
 if action=='begin':
  if list(BASE.iterdir()):raise ValueError('workspace already staged')
  with open(partial,'xb'):pass
 elif action=='chunk':
  raw=base64.b64decode(payload,validate=True)
  if len(raw)>12288 or partial.stat().st_size+len(raw)>1048576:raise ValueError('workspace transfer limit')
  with open(partial,'ab') as target:target.write(raw)
 elif action=='seal':
  raw=partial.read_bytes()
  if hashlib.sha256(raw).hexdigest()!=payload:raise ValueError('workspace transfer digest')
  data=validate(json.loads(raw))
  if data['snapshotId']!=value:raise ValueError('workspace identity mismatch')
  partial.rename(sealed)
 else:raise ValueError('workspace action')
 print('NIDUS_WORKSPACE_ACK',value,action,flush=True)
