"""Workspace and Vault boundary checks."""
from pathlib import Path


def validate_vault_location(vault):
    path = Path(vault).expanduser().resolve()
    source = Path(__file__).resolve().parents[1]
    if path == source or source.is_relative_to(path):
        raise ValueError('Vault must be outside the Nidus source workspace')
    return path
