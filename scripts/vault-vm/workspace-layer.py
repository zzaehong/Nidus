"""Adds the stage-2 workspace pieces to an already built development guest.

A full rebuild (prepare.py) needs the original pinned Alpine inputs. When only the built
dist/vm-assets remain, this appends one initramfs layer with the current init, the session
runners, the egress relay and the browser bridge; later cpio entries replace earlier ones at boot.

Usage: python3 scripts/vault-vm/workspace-layer.py dist/vm-assets [fonts-dir]
fonts-dir defaults to dist/vm-inputs/fonts (filled by fetch-fonts.py).

Re-running is safe: the initrd is cut back to the recorded base length before appending.
"""
import hashlib, json, os, pathlib, shutil, sys, tempfile
from newc import write as write_initramfs
import importlib.util

here = pathlib.Path(__file__).resolve().parent
assets = pathlib.Path(sys.argv[1]).resolve()
manifest_path = assets / 'manifest.json'
manifest = json.loads(manifest_path.read_text())
if manifest.get('profile') != 'development':
    raise SystemExit('egress needs the development guest')
initrd = assets / 'initrd'
spec = importlib.util.spec_from_file_location('fetch_fonts', here / 'fetch-fonts.py')
fetch_fonts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetch_fonts)
fonts = fetch_fonts.verified(sys.argv[2] if len(sys.argv) > 2 else here.parent.parent / 'dist/vm-inputs/fonts')


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


base = manifest.get('layerBase') or manifest.get('egressBase')
if base:
    # Strip the previous egress layer, after checking the base is the one recorded.
    if os.path.getsize(initrd) < base['bytes'] or sha256(initrd, base['bytes']) != base['sha256']:
        raise SystemExit('initrd base does not match the recorded layer base')
else:
    if sha256(initrd) != manifest['initrd']:
        raise SystemExit('initrd does not match manifest')
    base = {'bytes': os.path.getsize(initrd), 'sha256': manifest['initrd']}

with tempfile.TemporaryDirectory(prefix='nidus-workspace-layer-') as staging:
    root = pathlib.Path(staging)
    root.chmod(0o755)
    shutil.copyfile(here / 'init.sh', root / 'init')
    (root / 'init').chmod(0o755)
    helpers = root / 'opt/development/nidus'
    helpers.mkdir(parents=True)
    for name in ['session.py', 'child.py', 'egress-relay.py']:
        shutil.copyfile(here / name, helpers / name)
        (helpers / name).chmod(0o644)
    browser = root / 'opt/development/usr/lib/nidus'
    browser.mkdir(parents=True)
    shutil.copyfile(here / 'browser-bridge.mjs', browser / 'browser-bridge.mjs')
    (browser / 'browser-bridge.mjs').chmod(0o644)
    cjk = root / 'opt/development/usr/share/fonts/noto-cjk'
    cjk.mkdir(parents=True)
    for font in fonts:
        shutil.copyfile(font, cjk / font.name)
        (cjk / font.name).chmod(0o644)
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

manifest.pop('egressBase', None)
manifest.update({'initrd': sha256(initrd), 'egressVersion': 1, 'browserWorkspaceVersion': 1, 'cjkFonts': 1, 'layerBase': base})
manifest_path.write_text(json.dumps(manifest, indent=2))
print('workspace layer applied; initrd', manifest['initrd'])
