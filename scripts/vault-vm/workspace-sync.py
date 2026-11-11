"""Workspace transfer, guest side (host side: src/workspace/sync.ts, src/vault/apple-backend.ts).

Run by the root supervisor (init) inside the development root:
  workspace-sync.py import <task> <token> <bytes> <sha256>
  workspace-sync.py export <task> <token> <base>

Bytes travel over the egress link's "workspace" service (127.0.0.1:3130). Every transfer starts
with a one-time token the host sent on the control console, which processes in sessions cannot
read. Git inside the workspace runs as the session user (uid 1000) with hooks and fsmonitor off:
the repository is the AI's to change, so root never runs its code.
Workspaces live in /workspaces/<task> (the Vault's cache disk when attached).
"""
import hashlib, os, pathlib, re, shutil, socket, stat, subprocess, sys

ROOT = pathlib.Path('/workspaces')
CURRENT = pathlib.Path('/run/workspace-current')
MAX_IMPORT = 256 * 1024 * 1024
MAX_EXPORT = 128 * 1024 * 1024
USER = 1000
SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'safe.directory=*',
        '-c', 'user.name=Nidus Worker', '-c', 'user.email=worker@nidus.invalid', '-c', 'advice.detachedHead=false']
ENV = {'PATH': '/usr/bin:/bin', 'HOME': '/tmp', 'LANG': 'C.UTF-8', 'GIT_CONFIG_NOSYSTEM': '1',
       'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0'}


def say(*parts):
    print(*parts, flush=True)


def git(cwd, *args):
    result = subprocess.run(['git', *SAFE, *args], cwd=cwd, env=ENV, user=USER, group=USER, extra_groups=[],
                            stdin=subprocess.DEVNULL, capture_output=True, timeout=600)
    if result.returncode != 0:
        raise RuntimeError(args[0] + ': ' + result.stderr.decode(errors='replace').strip()[-200:])
    return result.stdout.decode().strip()


def link(token):
    connection = socket.create_connection(('127.0.0.1', 3130), timeout=60)
    connection.sendall(token.encode() + b'\n')
    return connection


def import_(task, token, size, digest):
    size = int(size)
    if not 0 < size <= MAX_IMPORT or not re.fullmatch(r'[0-9a-f]{64}', digest):
        raise ValueError('import size')
    target = ROOT / task
    if target.exists():
        raise ValueError('workspace exists')
    staging = ROOT / f'.import-{task}'
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(mode=0o700)
    os.chown(staging, USER, USER)
    bundle = staging / 'in.bundle'
    received, check = 0, hashlib.sha256()
    with link(token) as connection, open(bundle, 'wb') as out:
        while received < size:
            chunk = connection.recv(min(1 << 20, size - received))
            if not chunk:
                break
            received += len(chunk)
            check.update(chunk)
            out.write(chunk)
    if received != size or check.hexdigest() != digest:
        raise ValueError('import incomplete')
    os.chown(bundle, USER, USER)
    target.mkdir(mode=0o755)
    os.chown(target, USER, USER)
    git(ROOT, 'clone', '--quiet', str(bundle), str(target))
    git(target, 'remote', 'remove', 'origin')
    git(target, 'checkout', '--quiet', '-b', f'nidus/{task}')
    # The AI commits as the Worker; the user sees that author in the review.
    git(target, 'config', 'user.name', 'Nidus Worker')
    git(target, 'config', 'user.email', 'worker@nidus.invalid')
    shutil.rmtree(staging)
    CURRENT.write_text(task)
    say('NIDUS_WORKSPACE_IMPORTED', task, git(target, 'rev-parse', 'HEAD'))


def export(task, token, base):
    if not re.fullmatch(r'[0-9a-f]{40}', base):
        raise ValueError('base')
    workspace = ROOT / task
    info = workspace.lstat()
    if not stat.S_ISDIR(info.st_mode):
        raise ValueError('workspace missing')
    # Nothing is lost: changes the AI did not commit go in as one last commit.
    if git(workspace, 'status', '--porcelain'):
        git(workspace, 'add', '-A')
        git(workspace, 'commit', '--quiet', '-m', '작업 중 남은 변경 (Nidus가 커밋)')
    head = git(workspace, 'rev-parse', 'HEAD')
    with link(token) as connection:
        if head == base:
            say('NIDUS_WORKSPACE_EXPORTED', task, 0, '-', head)
            return
        out = ROOT / f'.export-{task}'
        shutil.rmtree(out, ignore_errors=True)
        out.mkdir(mode=0o700)
        os.chown(out, USER, USER)
        git(workspace, 'bundle', 'create', '--quiet', str(out / 'out.bundle'), 'HEAD', f'^{base}')
        # The file was written by the session user: open it without following links.
        fd = os.open(out / 'out.bundle', os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'rb') as source:
            size = os.fstat(source.fileno()).st_size
            if not stat.S_ISREG(os.fstat(source.fileno()).st_mode) or size > MAX_EXPORT:
                raise ValueError('export size')
            check = hashlib.sha256()
            while chunk := source.read(1 << 20):
                check.update(chunk)
                connection.sendall(chunk)
        shutil.rmtree(out)
    say('NIDUS_WORKSPACE_EXPORTED', task, size, check.hexdigest(), head)


if __name__ == '__main__':
    action, task, token = sys.argv[1:4]
    try:
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,62}', task) or not re.fullmatch(r'[0-9a-f]{32}', token):
            raise ValueError('arguments')
        if action == 'import':
            import_(task, token, *sys.argv[4:6])
        elif action == 'export':
            export(task, token, sys.argv[4])
        else:
            raise ValueError('action')
    except Exception as error:
        say('NIDUS_WORKSPACE_FAILED', task if re.fullmatch(r'[a-z0-9-]{1,63}', task or '') else '-', str(error).replace('\n', ' ')[:200])
