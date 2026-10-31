"""M0 flat-file copy protocol. No recursive export, overwrite, deletion or product API."""
import difflib
import hashlib
import os
import stat

LIMIT = 1024 * 1024

def filename(name):
    if not isinstance(name, str) or not name or name in ('.','..') or '/' in name or '\\' in name or any(ord(c)<32 for c in name):
        raise ValueError('Only top-level filenames are supported')
    lower = name.lower()
    if name.startswith('.') or lower.startswith('id_') or '.env' in lower or any(word in lower for word in ('secret','credential','token','keychain')) or lower.endswith(('.pem','.key','.p12','.pfx','.der','.sqlite','.db')):
        raise ValueError('Protected file')
    return name

def root_fd(path):
    if not os.path.isabs(path) or '..' in path.split('/'):
        raise ValueError('Absolute non-traversing root required')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.split('/'):
            if not part: continue
            child = os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            os.close(fd); fd=child
        return fd
    except BaseException:
        os.close(fd); raise

def read_file(root, name):
    fdroot = root_fd(str(root))
    try:
        fd = os.open(filename(name),os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fdroot)
        try:
            before=os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1 or before.st_size>LIMIT:
                raise ValueError('Only bounded single-link regular files')
            data=b''
            while len(data)<=LIMIT:
                block=os.read(fd,min(65536,LIMIT+1-len(data)))
                if not block: break
                data+=block
            after=os.fstat(fd)
            current=os.stat(name,dir_fd=fdroot,follow_symlinks=False)
            identity=lambda s:(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns,s.st_nlink)
            if len(data)>LIMIT or identity(before)!=identity(after) or identity(after)!=identity(current):
                raise ValueError('File changed during read')
            return data
        finally: os.close(fd)
    finally: os.close(fdroot)

def digest(data): return hashlib.sha256(data).hexdigest()

def create_file(root,name,data):
    fdroot=root_fd(str(root))
    try:
        # O_EXCL prevents replacing an existing file or a substituted symlink, atomically.
        fd=os.open(filename(name),os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fdroot)
        try:
            view=memoryview(data)
            while view:
                count=os.write(fd,view)
                if count<=0: raise OSError('Incomplete write')
                view=view[count:]
            os.fsync(fd)
        finally: os.close(fd)
    finally: os.close(fdroot)

def export_file(vault,workspace,name,approved_hash):
    data=read_file(vault,name)
    if digest(data)!=approved_hash: raise ValueError('Approval is stale')
    create_file(workspace,name,data)

def proposal(workspace,name):
    data=read_file(workspace,name)
    text=data.decode('utf-8')
    return {'name':filename(name),'sha256':digest(data),'diff':''.join(difflib.unified_diff([],text.splitlines(keepends=True),fromfile='/dev/null',tofile=name))}

def apply_new_file(workspace,vault,review,approved=False,vm_stopped=False):
    if not approved or not vm_stopped: raise ValueError('Separate approval and confirmed VM stop required')
    data=read_file(workspace,review['name'])
    if digest(data)!=review['sha256']: raise ValueError('Output changed after review')
    create_file(vault,review['name'],data)
