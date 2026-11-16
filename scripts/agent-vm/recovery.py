"""M0 recovery bridge. Sanitized metadata only; no guest text or process killing."""
import fcntl, datetime, hashlib, json, os, pathlib, socket, stat, subprocess, sys, uuid
from lifecycle import reconcile
from workspace import read_file, root_fd


def boot_id():
    try:
        return str(uuid.UUID(subprocess.check_output(['/usr/sbin/sysctl','-n','kern.bootsessionuuid'],stderr=subprocess.DEVNULL,text=True,timeout=2).strip()))
    except (OSError,ValueError,subprocess.SubprocessError):return None


def load(path):
    path=pathlib.Path(path)
    directory=root_fd(str(path.absolute().parent))
    try:fd=os.open(path.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory)
    finally:os.close(directory)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_size>2_000_000:raise ValueError('invalid-record')
        with os.fdopen(fd,'r',closefd=False) as f:return json.load(f)
    finally:os.close(fd)


def control(record,action):
    root=pathlib.Path(record['journal']).parent
    info=root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode & 0o077:raise ValueError('untrusted-channel')
    auth=load(root/'control.json')
    if auth['runID']!=record['runID']:raise ValueError('wrong-run')
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as peer:
        peer.settimeout(2);peer.connect(str(root/'control.sock'))
        peer.sendall(json.dumps(dict(auth,action=action)).encode())
        result=json.loads(peer.recv(4096))
    if result['runID']!=record['runID']:raise ValueError('wrong-run')
    return result


def integrity(record):
    """Only explicitly inventoried flat files; any extra or changed file refuses release."""
    try:
        for group in ('original','workspace'):
            item=record['integrity'][group];root=pathlib.Path(item['path']);expected=item['hashes']
            if not expected or set(p.name for p in root.iterdir())!=set(expected):return False
            for name,digest in expected.items():
                if hashlib.sha256(read_file(root,name)).hexdigest()!=digest:return False
        return True
    except (OSError,ValueError,KeyError,TypeError):return False


def boot_proof(record,current_boot):
    old=record.get('bootID')
    try:
        if not old or not current_boot or uuid.UUID(old)==uuid.UUID(current_boot):return False
    except (ValueError,TypeError):return False
    return True

def restart_proof(record,current_boot):
    return boot_proof(record,current_boot) and integrity(record)


def audit(record,action,result):
    root=pathlib.Path(record['journal']).parent
    info=root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode & 0o077:raise ValueError('untrusted-audit')
    fd=os.open(root/'recovery-events.jsonl',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode) or os.fstat(fd).st_nlink!=1:raise ValueError('invalid-audit')
        fcntl.flock(fd,fcntl.LOCK_EX)
        with os.fdopen(fd,'r+',closefd=False) as handle:
            rows=[json.loads(line) for line in handle.read().splitlines()]
            for row in rows:
                if not isinstance(row,dict) or row.get('action') not in ('status','cancel'):raise ValueError('invalid-audit')
                uuid.UUID(row['runID']);datetime.datetime.fromisoformat(row['at'])
            event={'runID':record['runID'],'action':action,'state':result['state'],'reason':result['reason'],'at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
            if not rows or action=='cancel' or any(rows[-1].get(k)!=event[k] for k in ('state','reason')):
                handle.seek(0,2);handle.write(json.dumps(event)+'\n');handle.flush();os.fsync(fd);rows.append(event)
            result['faultDetectedAt']=next((r['at'] for r in rows if r.get('runID')==record['runID'] and r.get('state') in ('STOP_UNCONFIRMED','FAILED')),None)
            result['recoveryAttempts']=[r['at'] for r in rows if r.get('runID')==record['runID'] and r.get('action')=='cancel'][-20:]
    finally:os.close(fd)


def snapshot(registry,action='status'):
    result={'runID':'unknown','vaultID':'unknown','detectedAt':None,'state':'STOP_UNCONFIRMED','lastState':None,
            'reason':'record-unavailable','stopConfirmed':False,'canStop':False,'locked':True,'bootChanged':False,
            'integrityVerified':False,'details':[]}
    record=None
    try:
        record=load(registry)
        run_id=str(uuid.UUID(record['runID']));result['runID']=run_id
        result['vaultID']=str(uuid.UUID(record['vaultID'])) if record.get('vaultID') else 'M0 diagnostic'
        journal=pathlib.Path(record['journal'])
        read_file(journal.parent,journal.name)
        live=None
        try:live=control(record,'status')
        except (OSError,ValueError,KeyError,TypeError):pass
        if action=='cancel':
            if not live or not live.get('canStop'):raise ValueError('control-unavailable')
            control(record,'cancel') # Acceptance is not stop success.
        status=reconcile(record['journal'],run_id,live_state=live.get('actualState') if live else None,restarting=live is None)
        result.update(state=status['state'],lastState=status['lastManagedState'],reason=status['reason'],
                      stopConfirmed=status['allowOperations'],canStop=bool(live and live.get('canStop')) and action!='cancel',locked=not status['allowOperations'])
        current_boot=boot_id()
        result['bootChanged']=boot_proof(record,current_boot)
        # Restart alone does not release: proof and both file inventories are mandatory.
        result['integrityVerified']=integrity(record)
        anchor=pathlib.Path(registry).stat()
        same_registry=record.get('registryIdentity')==[anchor.st_dev,anchor.st_ino]
        if same_registry and boot_proof(record,current_boot):
            verified=result['integrityVerified']
            result.update(state='STOP_CONFIRMED',reason='host-boot-changed-and-files-verified' if verified else 'host-boot-changed-files-unverified',stopConfirmed=True,locked=not verified,canStop=False)
        if not result['locked'] and record.get('integrity') and not result['integrityVerified']:
            result.update(locked=True,reason='file-integrity-unverified')
        info=pathlib.Path(record['journal']).stat()
        result['detectedAt']=datetime.datetime.fromtimestamp(info.st_mtime,datetime.timezone.utc).isoformat()
        # Only known action names, never raw errors, serial output, prompts or file content.
        known={'manager-ready','start-request','start-completed','termination-request','requestStop','forceStop-request','forceStop-completed','forceStop-failed','stop-confirmed','stop-unconfirmed','duplicate-stop','control-unavailable'}
        for line in pathlib.Path(record['journal']).read_text().splitlines()[-100:]:
            row=json.loads(line)
            if row.get('runID')==run_id and row.get('action') in known:result['details'].append(row['action'])
    except (OSError,ValueError,KeyError,TypeError):
        result.update(state='STOP_UNCONFIRMED',reason='record-or-control-unavailable',stopConfirmed=False,canStop=False,locked=True)
    if isinstance(record,dict) and 'journal' in record and 'runID' in record:
        try:audit(record,action,result)
        except (OSError,ValueError,TypeError,KeyError):result.update(locked=True,canStop=False,reason='audit-unavailable')
    return result

if __name__=='__main__':print(json.dumps(snapshot(sys.argv[1],sys.argv[2] if len(sys.argv)>2 else 'status')))
