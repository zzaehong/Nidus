"""Isolated developer vault locations for disposable tests and synthetic demos."""
import os
from pathlib import Path
import tempfile


def test_vault_root():
    root = Path(os.environ.get('NIDUS_VAULT_ROOT', Path(__file__).resolve().parents[2] / 'nidus_vault')).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def temporary_vault(prefix='nidus-test-', dir=None):
    base = Path(dir).resolve() if dir else test_vault_root()
    base.mkdir(parents=True, exist_ok=True)
    return tempfile.TemporaryDirectory(prefix=prefix, dir=base)


def persistent_vault(prefix='nidus-demo-', dir=None):
    base = Path(dir).resolve() if dir else test_vault_root()
    base.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix=prefix, dir=base))
