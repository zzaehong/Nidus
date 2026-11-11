"""Adds the stage-2 egress pieces to an already built development guest.

A full rebuild (prepare.py) needs the original pinned Alpine inputs. When only the built
dist/vm-assets remain, this appends one initramfs layer with the current init, the session
child runner and the egress relay; later cpio entries replace earlier ones at boot.

Usage: python3 scripts/vault-vm/egress-layer.py dist/vm-assets

Re-running is safe: the initrd is cut back to the recorded base length before appending.
"""
import hashlib, json, os, pathlib, shutil, sys, tempfile
from newc import write as write_initramfs

here = pathlib.Path(__file__).resolve().parent
assets = pathlib.Path(sys.argv[1]).resolve()
manifest_path = assets / 'manifest.json'
manifest = json.loads(manifest_path.read_text())
if manifest.get('profile') != 'development':
    raise SystemExit('egress needs the development guest')
initrd = assets / 'initrd'


def sha256(path, limit=None):
    digest = hashlib.sha256()
    remaining = limit
    with open(path, 'rb') as source:
        while remaining is None or remaining > 0:
            chunk = source.read(1024 * 1024 if remaining is None else min(1024 * 1024, remaining))
            if not chunk:
                break
            digest.update(chunk)
            if remaining is not None:
                remaining -= len(chunk)
    return digest.hexdigest()


base = manifest.get('egressBase')
if base:
    # Strip the previous egress layer, after checking the base is the one recorded.
    if os.path.getsize(initrd) < base['bytes'] or sha256(initrd, base['bytes']) != base['sha256']:
        raise SystemExit('initrd base does not match the recorded egress base')
else:
    if sha256(initrd) != manifest['initrd']:
        raise SystemExit('initrd does not match manifest')
    base = {'bytes': os.path.getsize(initrd), 'sha256': manifest['initrd']}

with tempfile.TemporaryDirectory(prefix='nidus-egress-layer-') as staging:
    root = pathlib.Path(staging)
    root.chmod(0o755)
    shutil.copyfile(here / 'init.sh', root / 'init')
    (root / 'init').chmod(0o755)
    helpers = root / 'opt/development/nidus'
    helpers.mkdir(parents=True)
    for name in ['child.py', 'egress-relay.py']:
        shutil.copyfile(here / name, helpers / name)
        (helpers / name).chmod(0o644)
    layer = root.parent / (root.name + '.gz')
    try:
        write_initramfs(root, layer)
        pending = assets / 'initrd.pending'
        with open(initrd, 'rb') as source, open(pending, 'wb') as out:
            remaining = base['bytes']
            while remaining:
                chunk = source.read(min(1024 * 1024, remaining))
                if not chunk:
                    raise SystemExit('initrd shorter than base')
                out.write(chunk)
                remaining -= len(chunk)
            with open(layer, 'rb') as extra:
                shutil.copyfileobj(extra, out)
        pending.replace(initrd)
    finally:
        layer.unlink(missing_ok=True)

manifest.update({'initrd': sha256(initrd), 'egressVersion': 1, 'egressBase': base})
manifest_path.write_text(json.dumps(manifest, indent=2))
print('egress layer applied; initrd', manifest['initrd'])
