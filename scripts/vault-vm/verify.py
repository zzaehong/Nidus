"""Real VM evidence; synthetic commands only, no provider calls, Host mounts or network."""
import subprocess, json, time, pathlib, sys, threading, queue, base64, hashlib, platform
assets=pathlib.Path(sys.argv[1]).resolve(); dest=pathlib.Path(sys.argv[2])
p=subprocess.Popen(['dist/nidus-vault-vm',str(assets/'Image'),str(assets/'initrd')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
q=queue.Queue(); events=[]; cases=[]
def reader():
 for line in p.stdout:
  try:q.put(json.loads(line))
  except ValueError:pass
threading.Thread(target=reader,daemon=True).start()
def send(line):p.stdin.write(line+'\n');p.stdin.flush()
def wait_for(predicate,seconds=35):
 until=time.monotonic()+seconds
 while time.monotonic()<until:
  try:event=q.get(timeout=.2)
  except queue.Empty:
   if p.poll() is not None: raise RuntimeError('manager exited')
   continue
  events.append(event)
  if predicate(event):return event
 raise TimeoutError('VM event deadline')
asset_hashes={n:hashlib.sha256((assets/n).read_bytes()).hexdigest() for n in ['Image','initrd']}
commands=[('simple','echo hello; pwd; id',10),('setsid','setsid sh -c "while :; do sleep 1; done" & echo detached',10),('double-fork','sh -c \'sh -c "sleep 120 &" &\'; echo parent-exit',10),('infinite','while :; do :; done',1),('ignore-term',"trap '' TERM; while :; do sleep 1; done",1),('background','sleep 120 & echo background',10),('state-write','echo isolated > /tmp/private; export PRIVATE=value; echo done',10),('state-clean','test ! -e /tmp/private && test -z "$PRIVATE" && echo clean',10),('no-host-network','test ! -e /proc && test ! -e /sys && test ! -e /host && echo isolated',10),('privilege','busybox id; busybox unshare -Ur /bin/sh -c id; echo no > /bin/busybox',10),('output-limit','busybox yes bounded',10),('fd-boundary', 'for n in $(busybox seq 3 63); do (eval \"echo NIDUS_FD_ESCAPE >&$n\") 2>/dev/null; done; echo fd-checked',10),('long-command', '#'+'x'*5000+'\necho long-command',10),('network-block','busybox wget -T 1 -O /tmp/out http://169.254.169.254/; busybox wget -T 1 -O /tmp/out http://127.0.0.1/',10)]
try:
 wait_for(lambda e:e['event']=='ready')
 for id,command,seconds in commands:
  send('execute %s %s %d'%(id,base64.b64encode(command.encode()).decode(),seconds))
  e=wait_for(lambda e:e.get('line','').startswith('NIDUS_RESULT '+id+' '),seconds+10)
  fields=e['line'].split();out='' if fields[6]=='-' else base64.b64decode(fields[6]).decode(errors='replace');err='' if fields[7]=='-' else base64.b64decode(fields[7]).decode(errors='replace')
  cases.append({'name':id,'exitCode':int(fields[2]),'cleanupConfirmed':fields[3]=='1','reason':fields[4],'memoryPeakBytes':fields[5],'stdout':out,'stderr':err})
 assert all(c.get('cleanupConfirmed') for c in cases)
 assert all(c['exitCode']==0 for c in cases if c['name'] in ['simple','setsid','double-fork','background','state-write','state-clean','no-host-network'])
 assert all(c['reason']=='timeout' for c in cases if c['name'] in ['infinite','ignore-term'])
 assert not any(e.get('line','').startswith('NIDUS_FD_ESCAPE') for e in events)
 assert any(c['name']=='long-command' and c['stdout']=='long-command\n' for c in cases)
 assert 'uid=1000' in cases[0]['stdout']
 assert all(c['exitCode']!=0 for c in cases if c['name'] in ['privilege','output-limit','network-block'])
 send('stop');wait_for(lambda e:e['event']=='STOP_CONFIRMED',12);p.wait(timeout=5)
except Exception as e:
 cases.append({'error':str(e)});
 if p.poll() is None:
  try:send('stop');wait_for(lambda e:e['event']=='STOP_CONFIRMED',12)
  except Exception:pass
finally:
 if p.poll() is None:p.kill();p.wait()
 dest.write_text(json.dumps({'assets':asset_hashes,'host':platform.platform(),'scope':'Real Apple Virtualization offline guest. No user data. Diagnostic only.','events':events,'cases':cases,'managerExit':p.returncode,'stderr':p.stderr.read()},indent=2)+'\n')
print(json.dumps(cases,indent=2))

sys.exit(1 if any("error" in case for case in cases) or p.returncode != 0 else 0)
