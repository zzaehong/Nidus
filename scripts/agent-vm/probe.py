"""Real VM M0 observer. Only synthetic data, isolated socketpair, no Provider calls."""
import json
import os
import pathlib
import resource
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from workspace import export_file,digest,proposal,apply_new_file,read_file

HERE=pathlib.Path(__file__).resolve().parent

def termination_verdict(active,continued,confirmed):
    if not active:return 'NOT_RUN'
    if continued:return 'FAIL'
    return 'PASS' if confirmed else 'NOT_RUN'

def supervisor():
    config=json.loads(sys.stdin.readline())
    fd=config.get('networkFD')
    with open(config['events'],'wb') as out,open(config['errors'],'wb') as err:
        worker=subprocess.Popen(config['argv'],stdin=subprocess.PIPE,stdout=out,stderr=err,
            env={'PATH':'/usr/bin:/bin','HOME':config['home'],'TMPDIR':config['home']},pass_fds=() if fd is None else (fd,))
        for line in sys.stdin:
            command=line.strip()
            if command=='kill-worker':
                worker.kill();worker.wait();break
            if command=='timeout':
                time.sleep(0.5);command='forceStop'
            if worker.poll() is not None:break
            try:worker.stdin.write((command+'\n').encode());worker.stdin.flush()
            except BrokenPipeError:break
        if worker.poll() is None:
            worker.stdin.close()  # UI/controller loss is fail-closed forceStop, not approval.
            try: worker.wait(timeout=5)
            except subprocess.TimeoutExpired: worker.kill();worker.wait()
    usage=resource.getrusage(resource.RUSAGE_CHILDREN)
    pathlib.Path(config['home'],'resources.json').write_text(json.dumps({'workerMaxResidentBytes':usage.ru_maxrss,
        'workerUserCPUSeconds':usage.ru_utime,'workerSystemCPUSeconds':usage.ru_stime,
        'scope':'VM worker and reaped children only; excludes separate Virtualization services'}))
    return

def scenario(assets,mode,trigger,network):
    directory=pathlib.Path(tempfile.mkdtemp(prefix='nidus-vm-case-',dir='/private/tmp'))
    vault=directory/'original';vault.mkdir();ws=directory/'workspace';ws.mkdir()
    (vault/'input.txt').write_bytes(b'approved fixture\n')
    (vault/'.env').write_text('SYNTHETIC_SECRET_NOT_FOR_GUEST')
    (vault/'.nidus').mkdir();(vault/'.git').mkdir()
    export_file(vault,ws,'input.txt',digest(b'approved fixture\n'))
    events=directory/'events.jsonl';serial=directory/'serial.log'
    receiver=guest=None
    if network:
        receiver,guest=socket.socketpair(socket.AF_UNIX,socket.SOCK_DGRAM)
        receiver.setblocking(False)
        for s in (receiver,guest):s.setsockopt(socket.SOL_SOCKET,socket.SO_SNDBUF,65536);s.setsockopt(socket.SOL_SOCKET,socket.SO_RCVBUF,262144)
    for image in ('Image','probe-initrd.gz'):
        shutil.copyfile(assets/image,directory/image)
        (directory/image).chmod(0o400)
    argv=[str(assets/'vm-probe'),str(directory/'Image'),str(directory/'probe-initrd.gz'),str(ws),str(serial),mode]
    if guest:argv.append(str(guest.fileno()))
    controller=subprocess.Popen([sys.executable,str(__file__),'supervisor'],stdin=subprocess.PIPE,
       env={'PATH':'/usr/bin:/bin','NIDUS_FIXTURE_SECRET':'synthetic-only'},pass_fds=() if guest is None else (guest.fileno(),))
    controller.stdin.write((json.dumps({'argv':argv,'events':str(events),'errors':str(directory/'errors.log'),
       'home':str(directory),'networkFD':None if guest is None else guest.fileno()})+'\n').encode());controller.stdin.flush()
    if guest:guest.close()
    started=time.monotonic();frames=accepted=rejected=0;network_closed=False
    def drain():
        nonlocal frames,accepted,rejected,network_closed
        if receiver:
            while True:
                try:packet=receiver.recv(65536)
                except BlockingIOError:break
                except ConnectionResetError:network_closed=True;break
                if not packet:network_closed=True;break
                frames+=1
                allowed=False
                if len(packet)>=42 and packet[12:14]==b'\x08\x00' and packet[23]==17:
                    ihl=(packet[14]&15)*4;port=int.from_bytes(packet[14+ihl+2:14+ihl+4],'big')
                    allowed=packet[30:34]==socket.inet_aton('192.0.2.1') and port==9000 and packet[14+ihl+8:]==b'approved'
                if allowed:accepted+=1
                else:rejected+=1
                # No packet is ever forwarded onto the host network. Approved means local sink receipt only.
    def pause(seconds):
        until=time.monotonic()+seconds
        while time.monotonic()<until:drain();time.sleep(.02)
        drain()
    def state_events():
        if not events.exists():return []
        rows=[]
        for line in events.read_text().splitlines():
            try:rows.append(json.loads(line))
            except json.JSONDecodeError:pass
        return rows
    def size():return (ws/'heartbeat').stat().st_size if (ws/'heartbeat').exists() else 0
    def send(command):
        if controller.poll() is None:
            try:controller.stdin.write((command+'\n').encode());controller.stdin.flush()
            except BrokenPipeError:pass
    confirmed=False
    result={'name':f'{mode}/{trigger}/{"sink-network" if network else "no-network"}','status':'NOT_RUN'}
    try:
        for _ in range(500):
            pause(.02)
            if size()>=2:break
            if any(row['action']=='failed' for row in state_events()):break
        boot=time.monotonic()-started
        text=serial.read_text(errors='replace') if serial.exists() else ''
        if size()<2:
            result['reason']='Guest workload did not start; not evidence of isolation'
            result['serialTail']=text[-2000:]
            send('forceStop');pause(.5)
        else:
            if mode=='ordinary' and trigger=='cancel':
                send('cleanup');pause(.1)
            # Allow an active network positive control before stopping the VM.
            pause(.5)
            active=size();before_network=frames
            stop_started=time.monotonic()
            if trigger in ('supervisor-kill','app-crash'):controller.kill();controller.wait()
            elif trigger=='worker-kill':send('kill-worker')
            elif trigger=='request-stop':send('requestStop');pause(.5);send('forceStop')
            elif trigger=='timeout':send('timeout')
            else:send('forceStop')
            for _ in range(150):
                pause(.02)
                if any(r['action'] in ('forceStop-completed','guest-stopped') and r['actualState']==0 for r in state_events()):
                    confirmed=True;break
                if trigger=='worker-kill' and controller.poll() is not None:break
            stop_seconds=time.monotonic()-stop_started
            if trigger=='invalid-stop' and confirmed:
                send('forceStop');pause(.1)
            pause(.3);before=size();network_before=frames
            pause(1.0);after=size();network_after=frames
            continued=after>before or network_after>network_before
            result.update(status=termination_verdict(True,continued,confirmed),activityStatus='FAIL' if continued else 'PASS',bootToWorkloadSeconds=round(boot,4),stopObservationSeconds=round(stop_seconds,4),
                writesBeforeStop=active,framesBeforeStop=before_network,writesAfterStop=after-before,framesAfterStop=network_after-network_before,
                observationSeconds=1.0,stopConfirmed=confirmed,terminal='stopped' if confirmed else 'interrupted-stop-unconfirmed',
                acceptedFrames=accepted,rejectedFrames=rejected,networkChannelClosed=network_closed,
                guestBootMarker='NIDUS_BOOT' in text,hostPathsAbsent='HOST_PATHS_ABSENT' in text,
                secretsAbsent='SECRET_PATHS_ABSENT' in text and 'ENV_SECRET_ABSENT' in text,
                originalUnchanged=(vault/'input.txt').read_bytes()==b'approved fixture\n' and (vault/'.env').read_text()=='SYNTHETIC_SECRET_NOT_FOR_GUEST',
                defaultNetworkBlocked='DEFAULT_NETWORK_BLOCKED' in text,parentEscapeBlocked='PARENT_ESCAPE_BLOCKED' in text,
                networkDevices=next((r['networkDevices'] for r in state_events() if r['action']=='create'),None))
            if confirmed:
                links_rejected=True
                for name in ('escape.txt','hard.txt'):
                    try:read_file(ws,name);links_rejected=False
                    except (ValueError,OSError):pass
                result['guestOutputLinksRejected']=links_rejected
                review=proposal(ws,'result.txt')
                try:apply_new_file(ws,vault,review,False,True);denied=False
                except ValueError:denied=not (vault/'result.txt').exists()
                apply_new_file(ws,vault,review,True,True)
                result['reviewApply']={'deniedWithoutApproval':denied,'approvedNewFileMatches':(vault/'result.txt').read_bytes()==b'fixture result\n'}
        all_events=state_events()
        confirmed=confirmed or any(r['action']=='forceStop-completed' and r['actualState']==0 for r in all_events)
        result['events']=all_events
        result['runningCleanupRejected']=any(r['action']=='cleanup-refused' for r in all_events)
        if trigger=='invalid-stop':result['invalidStopRejected']=any(r['action']=='forceStop-failed' for r in all_events)
        if trigger=='app-crash':result['appCrashScope']='Synthetic controller loss; actual SwiftUI app crash NOT_RUN'
        result['resources']={'configuredVCPUs':2,'configuredMemoryBytes':536870912,'peakResidentBytes':None,'cpuUsage':None,
                             'note':'VM service memory/CPU not inferred from controller RSS; resource accounting NOT_RUN'}
    except Exception as error:
        result.update(status='FAIL',reason=type(error).__name__+': '+str(error),events=state_events())
    finally:
        send('cleanup')
        if controller.poll() is None:
            controller.stdin.close()
            try:controller.wait(timeout=6)
            except subprocess.TimeoutExpired:controller.kill();controller.wait()
        if receiver:receiver.close()
        metrics=directory/'resources.json'
        if metrics.exists():result.setdefault('resources',{}).update(json.loads(metrics.read_text()))
        if confirmed:
            shutil.rmtree(directory);result['cleanup']='PASS' if not directory.exists() else 'FAIL'
        else:
            result['cleanup']='NOT_RUN';result['retainedDiagnosticDirectory']=str(directory)
    return result

def probe(assets):
    result={'schemaVersion':1,'phase':'M0-VM','generatedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),
      'backend':'Apple-Virtualization-Linux-ARM64-prototype','eligible':False,'checks':[],
      'host':subprocess.check_output(['sw_vers'],text=True).strip(),'guest':'Alpine v3.24 netboot / Linux 6.18.58-0-virt, custom diagnostic initramfs',
      'artifactHashes':json.loads((assets/'hashes.json').read_text()),
      'scope':'Synthetic flat-file workspace; no original Vault mounts, NAT, bridge, Provider calls or product activation.'}
    for mode,trigger,network in [('ordinary','cancel',False),('setsid','cancel',False),('double-fork','cancel',False),('nested','cancel',True),
         ('setsid','worker-kill',True),('setsid','supervisor-kill',True),('nested','timeout',False),('ordinary','request-stop',False),('setsid','app-crash',False),('ordinary','invalid-stop',False)]:
        row=scenario(assets,mode,trigger,network);result['checks'].append(row)
        (assets/'probe-checkpoint.json').write_text(json.dumps(result,indent=2))
        print(row['name']+': '+row['status'],file=sys.stderr,flush=True)
    active=[c for c in result['checks'] if c.get('guestBootMarker')]
    defaults=[c for c in active if c.get('networkDevices')==0]
    network=[c for c in active if c.get('networkDevices')==1]
    reviews=[c for c in active if c.get('reviewApply')]
    result['securityChecks']=[
        {'name':'default-network-no-device-and-unreachable','status':'PASS' if defaults and all(c['defaultNetworkBlocked'] for c in defaults) else 'NOT_RUN'},
        {'name':'isolated-network-sink-allow-and-reject','status':'PASS' if network and all(c['acceptedFrames']>0 and c['rejectedFrames']>0 for c in network) else 'NOT_RUN'},
        {'name':'host-path-secret-original-protection','status':'PASS' if active and all(c['hostPathsAbsent'] and c['secretsAbsent'] and c['originalUnchanged'] and c['parentEscapeBlocked'] for c in active) else 'FAIL'},
        {'name':'separate-new-file-review-approval','status':'PASS' if reviews and all(c['reviewApply']['deniedWithoutApproval'] and c['reviewApply']['approvedNewFileMatches'] and c['guestOutputLinksRejected'] for c in reviews) else 'NOT_RUN'},
        {'name':'running-cleanup-rejected','status':'PASS' if any(c.get('runningCleanupRejected') for c in active) else 'FAIL'},
        {'name':'invalid-stop-error-recorded','status':'PASS' if any(c.get('invalidStopRejected') for c in active) else 'NOT_RUN'},
        {'name':'confirmed-stop-job-images-cleanup','status':'PASS' if reviews and all(c['cleanup']=='PASS' for c in reviews) else 'FAIL'}]
    result['remaining']=[{'name':name,'status':'NOT_RUN'} for name in ['VM state confirmation after owner SIGKILL','actual SwiftUI app crash','general recursive workspace merge and adversarial directory races',
      'external network allowlist and DNS/redirect policy','macOS guest','full toolchain and browser','VM service CPU and peak memory accounting']]
    return result

if __name__=='__main__':
    if sys.argv[1]=='supervisor':supervisor()
    else:
        print(json.dumps(probe(pathlib.Path(sys.argv[1]).resolve()),indent=2));sys.exit(1)
