"""Downloads the pinned guest fonts (fonts.lock.json) into a directory and checks their hashes.

Usage: python3 scripts/vault-vm/fetch-fonts.py dist/vm-inputs/fonts
Files already present with the right hash are kept.
"""
import hashlib, json, pathlib, sys, urllib.request

LOCK = json.loads((pathlib.Path(__file__).resolve().parent / 'fonts.lock.json').read_text())


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def verified(directory):
    """Paths of the locked fonts in directory; raises if any is missing or differs."""
    directory = pathlib.Path(directory)
    paths = []
    for font in LOCK['fonts']:
        path = directory / font['name']
        if not path.is_file() or path.is_symlink() or path.stat().st_size != font['bytes'] or digest(path) != font['sha256']:
            raise SystemExit(f'font missing or changed: {path} (run scripts/vault-vm/fetch-fonts.py)')
        paths.append(path)
    return paths


if __name__ == '__main__':
    target = pathlib.Path(sys.argv[1])
    target.mkdir(parents=True, exist_ok=True)
    for font in LOCK['fonts']:
        path = target / font['name']
        if path.is_file() and digest(path) == font['sha256']:
            continue
        pending = path.with_suffix('.pending')
        with urllib.request.urlopen(font['url']) as response, open(pending, 'wb') as out:
            while chunk := response.read(1024 * 1024):
                out.write(chunk)
        if digest(pending) != font['sha256']:
            pending.unlink()
            raise SystemExit('hash mismatch: ' + font['name'])
        pending.replace(path)
    verified(target)
    print('fonts ready in', target)
