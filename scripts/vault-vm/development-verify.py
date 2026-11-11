"""Explicit real development VM test. Synthetic files only; no Provider requests."""
import subprocess,queue,threading,time,json,pathlib,uuid,base64,sys,hashlib
assets=pathlib.Path(sys.argv[1]);destination=pathlib.Path(sys.argv[2]);events=[];cases=[]
p=subprocess.Popen(['dist/nidus-vault-vm',str(assets/'Image'),str(assets/'initrd'),'development'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
q=queue.Queue()
def reader():
 for line in p.stdout:
  try:q.put(json.loads(line))
  except ValueError:pass
threading.Thread(target=reader,daemon=True).start()
def wait(predicate,seconds=60):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  try:e=q.get(timeout=.2)
  except queue.Empty:
   if p.poll() is not None:raise RuntimeError('manager exited')
   continue
  events.append(e)
  if predicate(e):return e
 raise TimeoutError('guest response')
def send(line):p.stdin.write(line+'\n');p.stdin.flush()
commands=[('versions','python3 --version; python3 -m pip --version; node --version; npm --version; git --version; bash --version | head -1; curl --version | head -1; gcc --version | head -1'),('python-json',"python3 -c 'import json,pathlib; p=pathlib.Path(\"result.json\");p.write_text(json.dumps({\"ok\":True}));assert json.loads(p.read_text())[\"ok\"];print(\"python-ok\")'"),('node-json',"node -e 'const f=require(\"fs\");f.writeFileSync(\"node.json\",JSON.stringify({ok:true}));if(!JSON.parse(f.readFileSync(\"node.json\")).ok)process.exit(1);console.log(\"node-ok\")'"),('python-test',"printf 'import unittest\nclass Test(unittest.TestCase):\n def test_sum(self): self.assertEqual(2+2,4)\n' > test_example.py; python3 -m unittest -v"),('node-test',"printf 'const {test}=require(\"node:test\");test(\"math\",()=>require(\"node:assert\").equal(2+2,4));' > math.test.js; node --test math.test.js"),('git-build',"git init -q; git status --porcelain; printf '#include <stdio.h>\nint main(){puts(\"build-ok\");return 0;}' > main.c; gcc main.c -o hello && ./hello"),('cleanup',"setsid bash -c 'sleep 120 &' & echo background"),('isolation','test ! -f result.json && test ! -f node.json && test ! -f test_example.py && id && echo clean')]
commands.extend([
 ('double-fork',"python3 -c 'import os,time; p=os.fork(); os._exit(0) if p else None; os.setsid(); p=os.fork(); os._exit(0) if p else None; time.sleep(120)'"),
 ('boundaries',"test ! -e /host; test ! -e /sys/fs/cgroup; test ! -w /usr/bin/node; if /bin/busybox unshare -Ur /bin/sh -c id; then exit 1; fi; if curl --connect-timeout 1 http://169.254.169.254/; then exit 1; fi; if curl --connect-timeout 1 http://127.0.0.1/; then exit 1; fi; echo isolated"),
 ('cancel',"trap '' TERM; while :; do sleep 1; done"),
 ('timeout',"trap '' TERM; while :; do :; done")
])
commands.append(('workspace',"python3 main.py; printf 'print(2)' > main.py; test ! -w /snapshot/main.py"))
commands.append(('chromium-offline-dom',"printf '<html><head><title>Nidus synthetic</title></head><body><h1>DOM verified</h1></body></html>' > page.html; /usr/lib/chromium/chromium --headless --no-sandbox --disable-gpu --disable-software-rasterizer --disable-dev-shm-usage --disable-background-networking --user-data-dir=/tmp/profile --dump-dom file:///work/page.html"))
try:
 wait(lambda e:e['event']=='ready')
 for name,command in commands:
  snapshot=''
  if name=='workspace':
   snapshot=str(uuid.uuid4());content='print("snapshot-ok")'
   data=json.dumps({'schemaVersion':1,'snapshotId':snapshot,'vaultId':str(uuid.uuid4()),'environmentId':str(uuid.uuid4()),'files':[{'path':'main.py','content':content,'hash':hashlib.sha256(content.encode()).hexdigest()}]}).encode()
   for action,payload in [('begin','-'),('chunk',base64.b64encode(data).decode()),('seal',hashlib.sha256(data).hexdigest())]:
    send('workspace-'+action+' '+snapshot+' '+payload)
    wait(lambda e:e.get('line','')=='NIDUS_WORKSPACE_ACK '+snapshot+' '+action,5)
  identity=str(uuid.uuid4());send(('execute-browser ' if name=='chromium-offline-dom' else 'execute-dev ')+identity+' '+base64.b64encode(('set -euo pipefail\n'+command).encode()).decode()+(' 1' if name=='timeout' else ' 30')+(' '+snapshot if snapshot else ''))
  if name=='cancel':time.sleep(.15);send('cancel '+identity)
  event=wait(lambda e:e.get('line','').startswith('NIDUS_RESULT '+identity+' '),45);parts=event['line'].split()
  decode=lambda x:'' if x=='-' else base64.b64decode(x).decode(errors='replace')
  case={'name':name,'exitCode':int(parts[2]),'cleanupConfirmed':parts[3]=='1','reason':parts[4],'memoryPeakBytes':int(parts[5]),'stdout':decode(parts[6]),'stderr':decode(parts[7])};cases.append(case)
  assert case['cleanupConfirmed'],case
  if name in ['cancel','timeout']:assert case['reason']==('cancelled' if name=='cancel' else 'timeout') and case['exitCode']!=0,case
  else:assert case['exitCode']==0,case
  if name=='workspace':
   chunks=[e['line'].split()[3] for e in events if e.get('line','').startswith('NIDUS_WORKSPACE_RESULT '+identity+' ')]
   changes=json.loads(b''.join(base64.b64decode(c) for c in chunks));assert changes==[{'path':'main.py','content':'print(2)'}],changes
   assert any(e.get('line','').startswith('NIDUS_WORKSPACE_END '+identity+' ') for e in events)
  if name=='chromium-offline-dom':assert '<h1>DOM verified</h1>' in case['stdout'],case
 send('stop');wait(lambda e:e['event']=='STOP_CONFIRMED',12);p.wait(timeout=5)
except Exception as e:
 cases.append({'status':'FAIL','error':str(e)})
 try:send('stop');wait(lambda e:e['event']=='STOP_CONFIRMED',12)
 except Exception:pass
finally:
 if p.poll() is None:p.kill();p.wait()
 destination.write_text(json.dumps({'scope':'Real Linux ARM64 development VM, no network devices or Host mounts','cases':cases,'events':events,'managerExit':p.returncode,'assets':{n:hashlib.sha256((assets/n).read_bytes()).hexdigest() for n in ['Image','initrd']}},indent=2)+'\n')
 print(json.dumps(cases,indent=2));sys.exit(1 if any(c.get('status')=='FAIL' for c in cases) or p.returncode else 0)
