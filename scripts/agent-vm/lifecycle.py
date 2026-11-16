"""Host-only execution safety reconciliation. No task memory or VM reconnect claims."""
import json
from pathlib import Path

STATES = ('CREATED','STARTING','RUNNING','STOP_REQUESTED','STOP_CONFIRMED','STOP_UNCONFIRMED','FAILED')

def reconcile(path, run_id, live_state=None, restarting=True):
    result={'state':'STOP_UNCONFIRMED','lastManagedState':None,'frameworkState':live_state,
            'reason':'missing-or-corrupt-record','allowOperations':False,'autoResume':False}
    try:
        rows=[json.loads(line) for line in Path(path).read_text().splitlines()]
        if not rows or any(not isinstance(r,dict) or not isinstance(r.get('action'),str) or type(r.get('actualState')) is not int for r in rows):return result
        owned=[r for r in rows if r.get('runID')==run_id]
        if not owned:return result
        state='CREATED';proof=False;uncertain=False
        for row in owned:
            action=row['action'];actual=row['actualState']
            if state=='STOP_CONFIRMED' and actual!=0:uncertain=True;proof=False
            if action=='start-request':state='STARTING';proof=False
            elif action=='start-completed':state='RUNNING';proof=False
            elif action in ('termination-request','requestStop','forceStop-request'):state='STOP_REQUESTED';proof=False
            elif action in ('failed','forceStop-failed'):state='FAILED';proof=False
            elif action in ('stop-unconfirmed','watchdog-expired'):state='STOP_UNCONFIRMED';uncertain=True;proof=False
            elif action in ('forceStop-completed','guest-stopped'):proof=actual==0
            elif action=='stop-confirmed':
                if not proof or actual!=0 or uncertain:return result
                state='STOP_CONFIRMED'
            elif action=='state-observed' and actual!=0:proof=False
        result['lastManagedState']=state
        if state=='STOP_CONFIRMED' and proof and not uncertain:
            if live_state is not None and live_state!=0:
                result['reason']='record-framework-mismatch';return result
            result.update(state=state,reason='owner-callback-and-stopped-record',allowOperations=True)
        elif restarting:
            result['reason']='no-authoritative-stop-proof-after-restart'
        else:result.update(state=state,reason='live-management-state')
        return result
    except (OSError,ValueError,TypeError,KeyError):return result
