"""Build the offline diagnostic guest from pinned public Alpine artifacts. No downloads here."""
import pathlib, hashlib, gzip, struct, subprocess, tempfile, shutil, sys
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
    subprocess.run(['tar','-xf',str(assets/'initramfs-virt'),'-C',tmp],check=True)
    shutil.copyfile(pathlib.Path(__file__).with_name('init.sh'),pathlib.Path(tmp)/'init')
    (pathlib.Path(tmp)/'init').chmod(0o755)
    archive=subprocess.check_output(['tar','--format=newc','-cf','-','-C',tmp,'.'])
    (assets/'initrd').write_bytes(gzip.compress(archive,mtime=0))
print('Verified kernel and built offline diagnostic initrd')
