"""Build a disposable initrd from official Alpine artifacts. No downloads or user files."""
import gzip, hashlib, json, pathlib, struct, subprocess, sys, tempfile
assets = pathlib.Path(sys.argv[1]).resolve()
source = pathlib.Path(__file__).resolve().parent
manifest = json.loads((source/'assets.json').read_text())
for name, item in manifest.items():
    if hashlib.sha256((assets/name).read_bytes()).hexdigest() != item['sha256']:
        raise SystemExit('Artifact hash mismatch: '+name)
kernel = (assets / 'vmlinuz-virt').read_bytes()
if kernel[4:8] != b'zimg' or kernel[24:28] != b'gzip':
    raise SystemExit('Unsupported kernel container; refusing guessed offsets')
offset, length = struct.unpack_from('<II', kernel, 8)
image = gzip.decompress(kernel[offset:offset+length])
if image[56:60] != b'ARM\x64': raise SystemExit('Not an ARM64 Linux Image')
(assets / 'Image').write_bytes(image)
with tempfile.TemporaryDirectory(prefix='nidus-initrd-') as root:
    subprocess.run(['tar', '-xf', str(assets/'initramfs-virt'), '-C', root], check=True)
    init = pathlib.Path(root)/'init'
    init.unlink()
    init.write_bytes((source/'guest-init.sh').read_bytes()); init.chmod(0o755)
    # bsdtar writes a Linux-readable newc archive; input files are publisher image content only.
    archive = subprocess.run(['tar','--format=newc','-cf','-','-C',root,'.'],check=True,stdout=subprocess.PIPE).stdout
    (assets/'probe-initrd.gz').write_bytes(gzip.compress(archive,mtime=0))
print(json.dumps({name:hashlib.sha256((assets/name).read_bytes()).hexdigest() for name in ['vmlinuz-virt','initramfs-virt','Image','probe-initrd.gz']},indent=2))
