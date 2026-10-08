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
    submit = commands.add_parser('submit')
    submit.add_argument('request')
    submit.add_argument('--source', action='append', required=True)
    submit.add_argument('--output', required=True)
    submit.add_argument('--priority', choices=['do-now', 'schedule', 'quick-task', 'later'], default='do-now')
    submit.add_argument('--mode', choices=['deterministic', 'generative'], default='deterministic')
    submit.add_argument('--model-policy', help='Non-secret JSON route policy; snapshotted into task')
    submit.add_argument('--require', action='append', default=[], help='Required literal phrase in model response')
    run = commands.add_parser('run')
    run.add_argument('task')
    run.add_argument('--execute-only', action='store_true')
    decide = commands.add_parser('decide')
    decide.add_argument('task')
    decide.add_argument('decision', choices=['approve', 'reject'])
    show = commands.add_parser('show')
    show.add_argument('task')
    listing = commands.add_parser('list')
    listing.add_argument('--archive', action='store_true')
    args = parser.parse_args()
    store = None
    try:
        store = Store(args.vault)
        if args.command == 'init':
            result = store.state('home')
        elif args.command == 'submit':
            with store.lock():
                result = store.submit(args.request, args.source, args.output, args.priority,
                    mode=args.mode, model_policy=load_policy(args.model_policy) if args.mode == 'generative' else None,
                    required_phrases=args.require)
        elif args.command == 'run':
            result = Runtime(store).run(args.task, args.execute_only)
        elif args.command == 'decide':
            result = Runtime(store).decide(args.task, args.decision)
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
