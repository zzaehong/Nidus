"""Repeat owner SIGKILL; host observer is not the VM owner. No launchd installation."""
import hashlib,json,pathlib,sys,tempfile,time
from manager_probe import scenario
from probe import scenario as legacy_scenario

assets=pathlib.Path(sys.argv[1]).resolve()
result={'schemaVersion':1,'phase':'M0-lifecycle-recovery','eligible':False,'generatedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'checks':[],
        'scope':'Synthetic independent test suites; never reinitialize an existing unresolved registry. Local datagram sink, no internet forwarding.'}
for iteration in range(5):
    root=pathlib.Path(tempfile.mkdtemp(prefix='nidus-recovery-',dir='/private/tmp'))
    registry=root/'registry';registry.write_text('null')
    row=scenario(assets,'setsid','manager-kill',registry,network=True,observation=5)
    row['iteration']=iteration+1
    row['status']='UNCONFIRMED' if row['status']=='NOT_RUN' else row['status']
    result['checks'].append(row)
    print('manager-kill '+str(iteration+1)+': '+row['status'],file=sys.stderr,flush=True)
for mode,trigger,fault in [('ordinary','cancel','none'),('ordinary','duplicate-start','none'),('nested','worker-kill','none'),('ordinary','cancel','error'),('ordinary','cancel','timeout')]:
    root=pathlib.Path(tempfile.mkdtemp(prefix='nidus-recovery-',dir='/private/tmp'))
    registry=root/'registry';registry.write_text('null')
    row=scenario(assets,mode,trigger,registry,network=True,observation=2,fault=fault)
    row['name']+='/'+fault
    result['checks'].append(row)
    print(row['name']+': '+row['status'],file=sys.stderr,flush=True)
for trigger in ('supervisor-kill','app-crash'):
    row=legacy_scenario(assets,'setsid',trigger,True)
    row['scope']='Existing controller EOF regression; app-crash is synthetic, not SwiftUI.'
    result['checks'].append(row)
    print(trigger+': '+row['status'],file=sys.stderr,flush=True)
result['sourceHashes']={str(f):hashlib.sha256(f.read_bytes()).hexdigest() for f in pathlib.Path(__file__).parent.iterdir() if f.is_file()}
print(json.dumps(result,indent=2));sys.exit(1)
