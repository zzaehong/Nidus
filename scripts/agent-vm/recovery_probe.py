"""Actual VM recovery UI bridge tests; no actual Mac reboot or user Vault."""
import json,pathlib,sys,tempfile,time,hashlib
from manager_probe import scenario
assets=pathlib.Path(sys.argv[1]).resolve();checks=[]
for trigger in ('ui-cancel','manager-kill','worker-kill'):
    root=pathlib.Path(tempfile.mkdtemp(prefix='nidus-ui-recovery-',dir='/private/tmp'));registry=root/'registry';registry.write_text('null')
    row=scenario(assets,'setsid',trigger,registry,observation=2)
    row['registry']=str(registry)
    after=row.get('recoveryAfter',{})
    if trigger=='manager-kill':
        row['status']='UNCONFIRMED' if row['status']=='NOT_RUN' else row['status']
        row['recoveryPolicy']='PASS' if after.get('locked') and not after.get('canStop') and row.get('newVMAdmissionBlocked') else 'FAIL'
    elif trigger=='ui-cancel':
        row['recoveryPolicy']='PASS' if row.get('recoveryBefore',{}).get('canStop') and after.get('stopConfirmed') and not row.get('stopAttempt',{}).get('stopConfirmed') else 'FAIL'
    checks.append(row);print(trigger+': '+row['status'],file=sys.stderr,flush=True)
print(json.dumps({'schemaVersion':1,'phase':'M0-user-recovery','eligible':False,'generatedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'checks':checks,
'sourceHashes':{str(f):hashlib.sha256(f.read_bytes()).hexdigest() for f in pathlib.Path(__file__).parent.iterdir() if f.is_file()},'actualHostReboot':'NOT_RUN','actualSwiftUICrash':'NOT_RUN'},indent=2));sys.exit(1)
