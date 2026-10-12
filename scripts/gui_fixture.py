"""Disposable browser QA fixture. Synthetic local HTTP model, never external APIs.
Run: PYTHONPATH=. python3 scripts/gui_fixture.py --vault /tmp/nidus-gui-qa
Not used by the product GUI; the bounded seeding loop is test infrastructure only.
"""
import argparse
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from nidus.gui import serve
from nidus.store import Store
from nidus.planning import PlanRuntime


class FakeModel(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        instructions = payload['messages'][0]['content']
        text = payload['messages'][1]['content']
        criteria = [{'criterion_id':'C1','status':'satisfied','reason':'Synthetic source supports the result'}]
        if 'Planning Context' in instructions:
            request = json.loads(text)['original_request']
            value = {'goal':request,'scope':'Public synthetic source only','completion_criteria':['Report source fact'],
                'constraints':['No inventions'],'expected_result':'Grounded report',
                'human_judgment_conditions':['Human policy choice'],'planning_reason':'One sufficient task',
                'tasks':[{'local_key':'T1','title':request,'goal':request,'priority':1,'depends_on':[],
                    'sources':['notes.md'],'completion_criteria':['Report source fact'],
                    'expected_output':'results/'+('task-escalate' if 'Task escalation' in request else 'final-escalate' if 'Final escalation' in request else 'report')+'.md'}]}
        elif 'Final Review Context' in instructions:
            escalate = 'Final escalation' in text
            value = {'decision':'ESCALATE' if escalate else 'COMPLETE','criteria':criteria,
                'reason':'Choose the acceptable policy' if escalate else 'Source fact reported',
                'questions':['Which policy should apply?'] if escalate else [], 'change':None}
        elif 'Task Review Context' in instructions:
            escalate = 'Task escalation' in text
            value = {'decision':'ESCALATE' if escalate else 'APPROVE','criteria':criteria,
                'reason':'Human policy choice required' if escalate else 'Source fact checked',
                'issues':[],'instructions':[],'questions':['Which policy should apply?'] if escalate else []}
        else:
            value = {'result':'Nidus stores task state locally in a vault.', 'self_check':criteria,
                'questions':[],'known_limitations':[]}
        self.server.calls += 1
        response = {'model':'synthetic-local','choices':[{'message':{'content':json.dumps(value)},'finish_reason':'stop'}],
                    'usage':{'prompt_tokens':0,'completion_tokens':0,'total_tokens':0}}
        self.send_response(200)
        self.send_header('Content-Type','application/json')
        self.end_headers()
        self.wfile.write(json.dumps(response).encode())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--vault', required=True)
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    vault = Path(args.vault)
    if vault.exists():
        raise ValueError('Fixture requires a new disposable vault')
    vault.mkdir(parents=True)
    (vault/'notes.md').write_text('Nidus stores task state locally in a vault.\n')
    model = HTTPServer(('127.0.0.1',0), FakeModel)
    model.calls = 0
    thread = threading.Thread(target=model.serve_forever, daemon=True)
    thread.start()
    policy = {'routes':[{'name':'synthetic-local','kind':'local','provider':'fixture','model':'fake',
                         'base_url':'http://127.0.0.1:%d/v1'%model.server_port}]}
    (vault/'fixture-policy.json').write_text(json.dumps(policy))
    store = Store(vault)
    try:
        runtime = PlanRuntime(store)
        for request in ('Task escalation · 정책 판단', 'Final escalation · 범위 판단'):
            p = runtime.submit(request,['notes.md'],policy)
            for _ in range(20):
                p = runtime.run(p['id'])
                if p['status']=='blocked':
                    raise ValueError(p['error'])
                if p['status']=='waiting':
                    if p['attention']['kind'] != 'transmission':
                        break
                    runtime.decide(p['id'],'approve')
                for identity in p['tasks']:
                    task=store.get(identity)
                    if task['status']=='waiting' and task['attention'].get('kind')!='quality':
                        runtime.runtime.decide(identity,'approve')
            else:
                raise ValueError('Fixture seeding exhausted')
    finally:
        store.close()
    print('Synthetic planning policy: '+json.dumps(policy),flush=True)
    try:
        serve(vault,args.port)
    finally:
        model.shutdown()
        model.server_close()


if __name__=='__main__':
    main()
