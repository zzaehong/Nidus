"""Build the offline diagnostic guest from pinned public Alpine artifacts. No downloads here."""
import pathlib, hashlib, gzip, struct, subprocess, tempfile, shutil, sys, os, json, importlib.util
from newc import write as write_initramfs, tree_digest
assets = pathlib.Path(sys.argv[1]).resolve()
pins = {'vmlinuz-virt':'849394914e6a93cc9bb17e901f445ce21fcd7e4528541d9496a74d6a6ccee319','initramfs-virt':'7b75e0475ce73eca283ab60eac28f2fe1a8b62e8ffd870c056baaafc9d6e9b1b'}
for name, digest in pins.items():
    if hashlib.sha256((assets/name).read_bytes()).hexdigest()!=digest: raise RuntimeError('asset digest mismatch')
kernel=(assets/'vmlinuz-virt').read_bytes()
assert kernel[4:8]==b'zimg' and kernel[24:28]==b'gzip'
offset,length=struct.unpack_from('<II',kernel,8)
image=gzip.decompress(kernel[offset:offset+length]);assert image[56:60]==b'ARM\x64'
(assets/'Image').write_bytes(image)
with tempfile.TemporaryDirectory(prefix='nidus-m4-build-') as tmp:
    root=pathlib.Path(tmp)
    subprocess.run(['tar','-xf',str(assets/'initramfs-virt'),'-C',tmp],check=True)
    shutil.copyfile(pathlib.Path(__file__).with_name('init.sh'),root/'init');(root/'init').chmod(0o755)
    cache_package=os.environ.get('NIDUS_VM_CACHE_KERNEL_APK')
    if cache_package and not os.environ.get('NIDUS_VM_DEVELOPMENT_ROOT'):raise ValueError('cache requires managed development image')
    if cache_package:
        spec=importlib.util.spec_from_file_location('cache_modules',pathlib.Path(__file__).with_name('cache-modules.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        module.install(cache_package,root,pins['vmlinuz-virt'])
    (assets/'features.json').write_text(json.dumps({'cacheDiskVersion':1 if cache_package else 0,'browserSnapshotVersion':1 if os.environ.get('NIDUS_VM_DEVELOPMENT_ROOT') else 0,'egressVersion':1 if os.environ.get('NIDUS_VM_DEVELOPMENT_ROOT') else 0,'browserWorkspaceVersion':1 if os.environ.get('NIDUS_VM_DEVELOPMENT_ROOT') else 0,'browserInteractiveVersion':1 if os.environ.get('NIDUS_VM_DEVELOPMENT_ROOT') else 0}))
    boot=assets/'boot-layer.gz';write_initramfs(root,boot)
    layers=[boot]
    development=os.environ.get('NIDUS_VM_DEVELOPMENT_ROOT')
    if development:
        source=pathlib.Path(development).resolve()
        if not (source/'nidus-packages.json').is_file():raise ValueError('development package manifest missing')
        # A locked package layer is reused; trusted supervisor code is a separate deterministic overlay.
        key=tree_digest(source)
        layer=assets/('development-'+key+'.gz')
        if not layer.exists():
            with tempfile.TemporaryDirectory(prefix='nidus-dev-layer-') as staging:
                shutil.copytree(source,pathlib.Path(staging)/'opt/development',symlinks=True)
                temporary=layer.with_suffix('.pending');write_initramfs(staging,temporary);temporary.replace(layer)
        layers.append(layer)
        with tempfile.TemporaryDirectory(prefix='nidus-guest-overlay-') as staging:
            helpers=pathlib.Path(staging)/'opt/development/nidus';helpers.mkdir(parents=True)
            for name in ['session.py','child.py','workspace.py','egress-relay.py','workspace-sync.py']:shutil.copyfile(pathlib.Path(__file__).with_name(name),helpers/name)
            browser=helpers.parent/'usr/lib/nidus';browser.mkdir(parents=True)
            shutil.copyfile(pathlib.Path(__file__).with_name('browser.mjs'),browser/'browser.mjs')
            shutil.copyfile(pathlib.Path(__file__).with_name('browser-live.mjs'),browser/'browser-live.mjs')
            shutil.copyfile(pathlib.Path(__file__).with_name('browser-dom.mjs'),browser/'browser-dom.mjs')
            shutil.copyfile(pathlib.Path(__file__).with_name('browser-bridge.mjs'),browser/'browser-bridge.mjs')
            # CJK fonts for the workspace browser: pinned inputs from fetch-fonts.py (NIDUS_VM_FONTS).
            spec=importlib.util.spec_from_file_location('fetch_fonts',pathlib.Path(__file__).with_name('fetch-fonts.py'));fonts=importlib.util.module_from_spec(spec);spec.loader.exec_module(fonts)
            cjk=helpers.parent/'usr/share/fonts/noto-cjk';cjk.mkdir(parents=True)
            for font in fonts.verified(os.environ['NIDUS_VM_FONTS']):shutil.copyfile(font,cjk/font.name)
            # APK post-install hooks are intentionally not executed on the Host.
            # Install only the BusyBox applets required by the managed development profile.
            binaries=helpers.parent/'usr/bin';binaries.mkdir(parents=True)
            for name in ['env','head','id','setsid','sleep','mkdir','rm','cat','ls','cp','mv','chmod','wc','sort','find','grep','sed','awk','tar','gzip','uname']:
                if not (source/'usr/bin'/name).exists() and not (source/'bin'/name).exists():
                    (binaries/name).symlink_to('../../bin/busybox')
            overlay=assets/'supervisor-layer.gz';write_initramfs(staging,overlay);layers.append(overlay)
    with open(assets/'initrd.pending','wb') as out:
        for layer in layers:
            with open(layer,'rb') as data:shutil.copyfileobj(data,out,1024*1024)
    (assets/'initrd.pending').replace(assets/'initrd')
print('Verified kernel and built deterministic initrd layers')
