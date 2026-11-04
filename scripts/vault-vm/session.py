"""Trusted guest supervisor. Workloads never run with its UID, FDs, or filesystem view."""
import os,sys,pathlib,subprocess,base64,time,json,shutil,threading,hashlib
ID,ENCODED,SECONDS=sys.argv[1:4]
if not ID or any(c not in '0123456789abcdef-' for c in ID):raise ValueError('session id')
SECONDS=int(SECONDS)
if not 1<=SECONDS<=120:raise ValueError('deadline')
ROOT=pathlib.Path('/sessions')/ID;CG=pathlib.Path('/sys/fs/cgroup')/ID
profile=sys.argv[4] if len(sys.argv)>4 else 'shell'
if profile not in ['shell','browser']:raise ValueError('profile')
CG.mkdir();ROOT.mkdir()
if profile=='browser':pathlib.Path('/proc/sys/user/max_user_namespaces').write_text('128')
(CG/'memory.max').write_text(str((1024 if profile=='browser' else 512)*1024*1024))
(CG/'pids.max').write_text('256' if profile=='browser' else '64')
(CG/'cpu.max').write_text('100000 100000')
for name in ['bin','lib','usr','etc','dev','dev/shm','proc','work','snapshot','tmp','home']:(ROOT/name).mkdir(parents=True,exist_ok=True)
for name in ['work','tmp','home','dev/shm']:os.chown(ROOT/name,1000,1000)
(ROOT/'etc/passwd').write_text('root:x:0:0:root:/:/bin/sh\nnidus:x:1000:1000:Session:/home:/bin/sh\n')
(ROOT/'etc/group').write_text('root:x:0:\nnidus:x:1000:\n')
command=base64.b64decode(ENCODED,validate=True).decode('utf8')
if len(command.encode())>16384 or '\0' in command:raise ValueError('command')
(ROOT/'task.sh').write_text(command);(ROOT/'task.sh').chmod(0o444)
snapshot=None
if len(sys.argv)>5 and sys.argv[5]:
 import workspace
 snapshot=workspace.load(sys.argv[5])
 for file in snapshot['files']:
  for base in ['snapshot','work']:
   target=ROOT/base/file['path'];target.parent.mkdir(parents=True,exist_ok=True);target.write_text(file['content']);target.chmod(0o444 if base=='snapshot' else 0o644)
   if base=='work':
    os.chown(target,1000,1000);parent=target.parent
    while parent!=ROOT/'work':os.chown(parent,1000,1000);parent=parent.parent
outputs=[bytearray(),bytearray()]
def drain(pipe,destination):
 while True:
  chunk=pipe.read(8192)
  if not chunk:break
  remaining=32768-len(destination)
  if remaining>0:destination.extend(chunk[:remaining])
def enter():
 (CG/'cgroup.procs').write_text(str(os.getpid()))
 if pathlib.Path('/run/'+ID+'.cancel').exists():os._exit(130)
p=subprocess.Popen(['/bin/busybox','unshare','--mount','--pid','--fork','/usr/bin/python3','/nidus/child.py',str(ROOT),ID,profile],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env={'PATH':'/usr/bin:/bin'},close_fds=True,preexec_fn=enter)
threads=[threading.Thread(target=drain,args=(pipe,destination),daemon=True) for pipe,destination in zip([p.stdout,p.stderr],outputs)]
for thread in threads:thread.start()
started=time.monotonic();reason='completed'
while p.poll() is None:
 if pathlib.Path('/run/'+ID+'.cancel').exists():reason='cancelled';(CG/'cgroup.kill').write_text('1')
 if time.monotonic()-started>=SECONDS:reason='timeout';(CG/'cgroup.kill').write_text('1')
 time.sleep(.02)
code=p.wait()
# Control-channel cancellation may kill the child before the polling loop observes it.
if pathlib.Path('/run/'+ID+'.cancel').exists():reason='cancelled'
(CG/'cgroup.kill').write_text('1')
clean=False
for _ in range(150):
 if 'populated 0' in (CG/'cgroup.events').read_text():clean=True;break
 time.sleep(.02)
for thread in threads:thread.join(timeout=2)
if any(thread.is_alive() for thread in threads):clean=False
peak=int((CG/'memory.peak').read_text())
if clean:
 if profile=='browser':pathlib.Path('/proc/sys/user/max_user_namespaces').write_text('0')
 if snapshot is not None and profile=='shell':
  try:
   result=json.dumps(workspace.export(ROOT,snapshot),ensure_ascii=False).encode('utf8')
   for index,offset in enumerate(range(0,len(result),12288)):
    print('NIDUS_WORKSPACE_RESULT',ID,index,base64.b64encode(result[offset:offset+12288]).decode(),flush=True)
   print('NIDUS_WORKSPACE_END',ID,hashlib.sha256(result).hexdigest(),flush=True)
  except Exception:
   print('NIDUS_WORKSPACE_INVALID',ID,flush=True)
 CG.rmdir();shutil.rmtree(ROOT)
 pathlib.Path('/run/busy').unlink(missing_ok=True)
pathlib.Path('/run/'+ID+'.cancel').unlink(missing_ok=True)
encoded=[base64.b64encode(data).decode() if data else '-' for data in outputs]
print('NIDUS_RESULT',ID,code if code>=0 else 128-code,int(clean),reason,peak,*encoded,flush=True)
