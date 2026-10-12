import argparse
import json
import sys
from .store import Store
from .runtime import Runtime
from .gateway import load_policy


def main():
    parser = argparse.ArgumentParser(description='Nidus local evidence-briefing runtime')
    parser.add_argument('--vault', required=True)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('init')
    gui = commands.add_parser('gui', help='Loopback-only local dashboard')
    gui.add_argument('--port', type=int, default=8765)
    submit = commands.add_parser('submit')
    submit.add_argument('request')
    submit.add_argument('--source', action='append', required=True)
    submit.add_argument('--output', required=True)
    submit.add_argument('--priority', choices=['do-now', 'schedule', 'quick-task', 'later'], default='do-now')
    submit.add_argument('--mode', choices=['deterministic', 'generative'], default='deterministic')
    submit.add_argument('--model-policy', help='Non-secret JSON route policy; snapshotted into task')
    submit.add_argument('--require', action='append', default=[], help='Required literal phrase in model response')
    submit.add_argument('--workflow', choices=['manager', 'legacy'], default='manager',
                        help='New generative tasks default to Manager review; deterministic mode stays offline')
    submit.add_argument('--contract', help='Explicit non-secret Manager contract JSON')
    submit.add_argument('--manager-policy', help='Optional separate Manager route policy')
    submit.add_argument('--max-reworks', type=int, default=2)
    run = commands.add_parser('run')
    run.add_argument('task')
    run.add_argument('--execute-only', action='store_true')
    run.add_argument('--review-only', action='store_true', help='Checkpoint approved review before final completion')
    decide = commands.add_parser('decide')
    decide.add_argument('task')
    decide.add_argument('decision', choices=['approve', 'reject'])
    quality = commands.add_parser('quality-decide', help='Human work-quality judgment, separate from permissions')
    quality.add_argument('task')
    quality.add_argument('decision', choices=['approve','rework','cancel'])
    quality.add_argument('--note', required=True)
    quality.add_argument('--instruction', action='append', default=[])
    show = commands.add_parser('show')
    show.add_argument('task')
    listing = commands.add_parser('list')
    listing.add_argument('--archive', action='store_true')
    plan_submit = commands.add_parser('plan-submit', help='Register a goal for Manager planning')
    plan_submit.add_argument('request')
    plan_submit.add_argument('--source', action='append', required=True)
    plan_submit.add_argument('--model-policy', required=True)
    plan_submit.add_argument('--worker-policy')
    plan_submit.add_argument('--review-policy')
    plan_submit.add_argument('--final-policy')
    plan_submit.add_argument('--initial-tasks', type=int, default=10)
    plan_submit.add_argument('--total-tasks', type=int, default=20)
    plan_submit.add_argument('--revisions', type=int, default=5)
    for name in ('plan-run','plan-show'):
        commands.add_parser(name).add_argument('plan')
    commands.add_parser('plan-list').add_argument('--archive', action='store_true')
    plan_decide = commands.add_parser('plan-decide')
    plan_decide.add_argument('plan')
    plan_decide.add_argument('decision', choices=['approve','reject','resume','cancel'])
    plan_decide.add_argument('--note', default='')
    args = parser.parse_args()
    store = None
    try:
        if args.command == 'gui':
            from .gui import serve
            serve(args.vault, args.port)
            return 0
        store = Store(args.vault)
        if args.command == 'init':
            result = store.state('home')
        elif args.command.startswith('plan-'):
            from .planning import PlanRuntime
            planner = PlanRuntime(store)
            if args.command == 'plan-submit':
                result = planner.submit(args.request, args.source, load_policy(args.model_policy),
                    load_policy(args.worker_policy) if args.worker_policy else None,
                    load_policy(args.review_policy) if args.review_policy else None,
                    {'initial_tasks':args.initial_tasks,'total_tasks':args.total_tasks,'revisions':args.revisions},
                    load_policy(args.final_policy) if args.final_policy else None)
            elif args.command == 'plan-run':
                result = planner.run(args.plan)
            elif args.command == 'plan-show':
                result = planner.board(args.plan)
            elif args.command == 'plan-list':
                result = store.plans(args.archive)
            else:
                result = planner.decide(args.plan, args.decision, args.note)
        elif args.command == 'submit':
            contract = None
            if args.contract:
                with open(args.contract, encoding='utf-8') as stream:
                    raw = stream.read(32769)
                if len(raw.encode('utf-8')) > 32768:
                    raise ValueError('Manager contract exceeds 32 KiB')
                contract = json.loads(raw)
            managed = args.mode == 'generative' and args.workflow == 'manager'
            if not managed and (args.contract or args.manager_policy):
                raise ValueError('Contract/manager policy require the Manager generative workflow')
            with store.lock():
                result = store.submit(args.request, args.source, args.output, args.priority,
                    mode=args.mode, model_policy=load_policy(args.model_policy) if args.mode == 'generative' else None,
                    required_phrases=args.require, workflow='manager' if managed else None,
                    manager_contract=contract,
                    manager_policy=load_policy(args.manager_policy) if args.manager_policy else None,
                    max_reworks=args.max_reworks)
        elif args.command == 'run':
            result = Runtime(store).run(args.task, args.execute_only, args.review_only)
        elif args.command == 'decide':
            result = Runtime(store).decide(args.task, args.decision)
        elif args.command == 'quality-decide':
            result = Runtime(store).quality_decide(args.task, args.decision, args.note, args.instruction)
        elif args.command == 'show':
            result = store.get(args.task)
            result['history'] = store.events(args.task)
        else:
            result = store.tasks(args.archive)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 2 if isinstance(result, dict) and result.get('status') == 'blocked' else 0
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        return 2
    finally:
        if store:
            store.close()


if __name__ == '__main__':
    sys.exit(main())
