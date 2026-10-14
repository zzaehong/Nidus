import argparse
from pathlib import Path
import sys

from .store import Store


def main():
    parser = argparse.ArgumentParser(description="Nidus local AI router")
    parser.add_argument("--data-dir", type=Path, default=Path.home() / ".local/share/nidus-router")
    commands = parser.add_subparsers(dest="command", required=True)
    serve = commands.add_parser("serve")
    serve.add_argument("--port", type=int, default=8787)
    commands.add_parser("reset-admin", help="Replace the administrator login token")
    commands.add_parser("rotate-api-key", help="Replace the client API key")
    args = parser.parse_args()
    directory = args.data_dir.expanduser().resolve()
    if any((p / ".git").exists() for p in (directory, *directory.parents)):
        parser.error("--data-dir must be outside any Git repository")
    if args.command == "serve" and not 1024 <= args.port <= 65535:
        parser.error("--port must be between 1024 and 65535")
    store = Store(directory)
    if args.command != "serve":
        kind = "admin" if args.command == "reset-admin" else "api"
        print(f"New {kind} token (shown once): {store.rotate_token(kind)}")
        return
    tokens = store.initialize_tokens()
    for kind, token in tokens.items():
        print(f"New {kind} token (shown once): {token}", flush=True)
    print(f"Dashboard: http://127.0.0.1:{args.port}", flush=True)
    from .app import create_app
    import uvicorn
    uvicorn.run(create_app(store=store, port=args.port), host="127.0.0.1", port=args.port,
                access_log=False, proxy_headers=False)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
