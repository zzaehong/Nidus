"""Deterministic newc initramfs: sorted paths, normalized metadata, streaming file bodies."""
import pathlib,stat,os,gzip,shutil

def write(root,destination):
 root=pathlib.Path(root);paths=[root]
 for directory,dirs,files in os.walk(root,followlinks=False):
  dirs.sort();files.sort();paths.extend(pathlib.Path(directory)/name for name in dirs+files)
 paths=sorted(set(paths),key=lambda p:p.relative_to(root).as_posix())
 with open(destination,'wb') as raw,gzip.GzipFile(filename='',fileobj=raw,mode='wb',mtime=0,compresslevel=6) as out:
  def header(name,mode,size,ino):
   encoded=name.encode()+b'\0';fields=[ino,mode,0,0,1,0,size,0,0,0,0,len(encoded),0]
   data=b'070701'+b''.join(('%08x'%x).encode() for x in fields)+encoded
   out.write(data);out.write(b'\0'*((-len(data))%4))
  for ino,path in enumerate(paths,1):
   name='.' if path==root else './'+path.relative_to(root).as_posix();s=path.lstat()
   if path.is_symlink():
    data=os.readlink(path).encode();header(name,stat.S_IFLNK|0o777,len(data),ino);out.write(data);out.write(b'\0'*((-len(data))%4))
   elif path.is_dir():header(name,stat.S_IFDIR|(s.st_mode&0o777),0,ino)
   elif path.is_file():
    header(name,stat.S_IFREG|(s.st_mode&0o777),s.st_size,ino)
    with open(path,'rb') as source:shutil.copyfileobj(source,out,1024*1024)
    out.write(b'\0'*((-s.st_size)%4))
   else:raise ValueError('unsupported initramfs object '+name)
  header('TRAILER!!!',0,0,len(paths)+1)


def tree_digest(root):
 """Bind cached layers to actual paths, modes and bytes, not just a claimed manifest."""
 import hashlib
 root=pathlib.Path(root);digest=hashlib.sha256()
 for directory,dirs,files in os.walk(root,followlinks=False):
  dirs.sort();files.sort()
  for name in sorted(dirs+files):
   path=pathlib.Path(directory)/name;info=path.lstat()
   digest.update(path.relative_to(root).as_posix().encode()+b'\0'+str(info.st_mode).encode()+b'\0')
   if path.is_symlink():digest.update(os.readlink(path).encode()+b'\0')
   elif path.is_file():
    digest.update(str(info.st_size).encode()+b'\0')
    with open(path,'rb') as source:
     for chunk in iter(lambda:source.read(1024*1024),b''):digest.update(chunk)
   elif not path.is_dir():raise ValueError('unsupported layer object')
 return digest.hexdigest()
