"""Independent VM owner/worker M0 diagnostic; socketpair has no public listener."""
import fcntl, json, os, pathlib, socket, subprocess, sys, tempfile, time, uuid


def recovered_stop(path, run_id):
    """No last-PID or quiet-heartbeat inference. Corrupt/truncated journals fail closed."""
    try:
        rows=[json.loads(line) for line in pathlib.Path(path).read_text().splitlines()]
        owned=[r for r in rows if r.get('runID')==run_id]
        return bool(owned) and owned[-1]['action']=='stop-confirmed' and owned[-1]['actualState']==0
    except (OSError, ValueError, KeyError, TypeError):
        return False


def require_stopped(path, run_id, operation):
    if operation not in ('apply','cleanup','new-execution') or not recovered_stop(path,run_id):
        raise ValueError('Unconfirmed execution blocks '+operation)


def begin_run(registry, journal, run_id):
    """Persist before VM creation; serialize admission across diagnostic observers."""
    with open(registry,'r+') as handle:
        fcntl.flock(handle,fcntl.LOCK_EX)
        previous=json.load(handle)  # Missing/corrupt registry refuses admission.
        if previous is not None:
            require_stopped(previous['journal'],previous['runID'],'new-execution')
        handle.seek(0)
        json.dump({'journal':str(journal),'runID':run_id},handle)
        handle.truncate();handle.flush();os.fsync(handle.fileno())


def worker(fd, run_id, behavior):
    peer=socket.socket(fileno=fd)
    peer.sendall((run_id+' start\n').encode())
    began=time.monotonic()
    while True:
        elapsed=time.monotonic()-began
        if elapsed>1:
            if behavior=='disconnect':return
            if behavior=='cancel':peer.sendall((run_id+' cancel\n'+run_id+' cancel\n').encode());behavior='wait'
            if behavior=='invalid':peer.sendall(b'wrong-run cancel\n');behavior='wait'
        if behavior!='silent' or elapsed<1:
            try:peer.sendall((run_id+' heartbeat\n').encode())
            except BrokenPipeError:return
        time.sleep(1)


def scenario(assets,mode,trigger,registry):
    root=pathlib.Path(tempfile.mkdtemp(prefix='nidus-manager-',dir='/private/tmp'))
    ws=root/'workspace';ws.mkdir();(ws/'input.txt').write_text('approved synthetic input\n')
    journal=root/'events.jsonl';run_id=str(uuid.uuid4())
    begin_run(registry,journal,run_id)
    manager_end,worker_end=socket.socketpair()
    clean={'PATH':'/usr/bin:/bin','HOME':str(root),'TMPDIR':str(root)}
    with journal.open('wb') as out,(root/'errors.log').open('wb') as err:
        manager=subprocess.Popen([str(assets/'vm-manager'),str(assets/'Image'),str(assets/'probe-initrd.gz'),str(ws),str(root/'serial.log'),mode,'manager',run_id,'3' if trigger=='timeout' else '20'],stdin=manager_end,stdout=out,stderr=err,env=clean)
    manager_end.close()
    child=subprocess.Popen([sys.executable,__file__,'worker',str(worker_end.fileno()),run_id,trigger],pass_fds=(worker_end.fileno(),),env=clean)
    worker_end.close()
    def size():
        try:return (ws/'heartbeat').stat().st_size
        except FileNotFoundError:return 0
    row={'name':mode+'/'+trigger,'runID':run_id,'directory':str(root),'status':'NOT_RUN'}
    try:
        deadline=time.monotonic()+10
        while size()<2 and time.monotonic()<deadline:time.sleep(.05)
        if size()<2:row['reason']='No active workload';return row
        row['activeBytes']=size()
        if trigger=='worker-kill':child.kill();child.wait()
        if trigger=='manager-kill':manager.kill();manager.wait()
        deadline=time.monotonic()+10
        while time.monotonic()<deadline and manager.poll() is None and not recovered_stop(journal,run_id):time.sleep(.05)
        confirmed=recovered_stop(journal,run_id)
        time.sleep(.3);before=size();time.sleep(1);after=size()
        row.update(stopConfirmed=confirmed,writesAfterStop=after-before,observationSeconds=1,status='PASS' if confirmed and after==before else ('FAIL' if after>before else 'NOT_RUN'))
        row['activityStatus']='PASS' if after==before else 'FAIL'
        # Reload in a fresh process: simulates observer restart, not VM takeover.
        restart=subprocess.run([sys.executable,__file__,'recover',str(journal),run_id],capture_output=True,text=True)
        row['restartAllowsOperations']=restart.returncode==0
        row['recoveryPolicyStatus']='PASS' if (restart.returncode==0)==confirmed else 'FAIL'
        if not confirmed:
            try:begin_run(registry,root/'forbidden-new-run',str(uuid.uuid4()));blocked=False
            except (ValueError,OSError,KeyError):blocked=True
            row['newVMAdmissionBlocked']=blocked
        row['events']=[json.loads(line) for line in journal.read_text().splitlines()]
        row['defaultNetworkBlocked']='DEFAULT_NETWORK_BLOCKED' in (root/'serial.log').read_text()
        return row
    finally:
        if child.poll() is None:child.kill();child.wait()
        if manager.poll() is None:
            # Only diagnostic process cleanup; never substitutes for a VM stop confirmation.
            manager.kill();manager.wait()
        # Retain diagnostics even on confirmed stop; no guest results automatically applied.


if __name__=='__main__':
    if sys.argv[1]=='worker':worker(int(sys.argv[2]),sys.argv[3],sys.argv[4])
    elif sys.argv[1]=='recover':
        try:
            for operation in ('apply','cleanup','new-execution'):require_stopped(sys.argv[2],sys.argv[3],operation)
        except ValueError:sys.exit(1)
    else:
        assets=pathlib.Path(sys.argv[1]).resolve();checks=[]
        suite=pathlib.Path(tempfile.mkdtemp(prefix='nidus-manager-suite-',dir='/private/tmp'))
        registry=suite/'registry.json';registry.write_text('null')
        for mode,trigger in [('ordinary','cancel'),('setsid','worker-kill'),('double-fork','worker-kill'),('nested','worker-kill'),('setsid','disconnect'),('ordinary','silent'),('nested','timeout'),('ordinary','invalid'),('setsid','manager-kill')]:
            row=scenario(assets,mode,trigger,registry);checks.append(row);print(row['name']+': '+row['status'],file=sys.stderr,flush=True)
        print(json.dumps({'schemaVersion':1,'phase':'M0-independent-manager','eligible':False,'host':subprocess.check_output(['sw_vers'],text=True).strip(),'generatedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'checks':checks,'remaining':['Manager death authoritative VM stop confirmation','Actual SwiftUI crash','External network policy','General workspace merge'],'scope':'Socketpair control, synthetic files, no NIC, no product integration. Journals and workspaces retained.'},indent=2))
        sys.exit(1)
