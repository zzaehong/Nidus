"""Local-only commits; never stage or commit unrelated user changes."""
import subprocess


class VaultGit:
    def __init__(self, vault):
        self.vault = vault
        git_dir = vault / '.git'
        if git_dir.is_symlink() or (git_dir.exists() and not git_dir.is_dir()):
            raise ValueError('Vault needs its own regular .git directory')
        if not git_dir.exists():
            self.call('init', '--quiet', '.')
        root = self.call('rev-parse', '--show-toplevel').strip()
        if str(vault) != root:
            raise ValueError('Git root does not match vault')

    def call(self, *arguments):
        try:
            result = subprocess.run(['git', '-c', 'core.hooksPath=/dev/null',
                '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false',
                '-c', 'user.name=Nidus Local Runtime', '-c', 'user.email=nidus@localhost',
                '-C', str(self.vault), *arguments], stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, text=True, timeout=30)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise ValueError('Vault Git unavailable: ' + str(error))
        if result.returncode:
            raise ValueError('Vault Git failed: ' + result.stderr.strip())
        return result.stdout

    def checkpoint(self, resources):
        paths = ['.nidus/state.sqlite3'] + sorted(set(resources))
        self.call('add', '--force', '--', *paths)
        changed = self.call('diff', '--cached', '--name-only', '--', *paths)
        if changed.strip():
            self.call('commit', '--quiet', '--only', '-m', 'nidus: checkpoint runtime state and artifacts', '--', *paths)
