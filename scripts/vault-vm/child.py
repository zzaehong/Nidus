"""Runs inside a new PID/mount namespace, joins cgroup before entry, drops privilege before code."""
import os,sys,subprocess,pathlib,ctypes,resource
root=pathlib.Path(sys.argv[1]);identity=sys.argv[2]
def mount(*args):subprocess.run(['/bin/busybox','mount',*args],check=True,stdin=subprocess.DEVNULL)
mount('--make-rprivate','/')
for path in ['bin','lib','usr']:
 mount('--bind','/'+path,str(root/path));mount('-o','remount,bind,ro,nosuid,nodev',str(root/path))
if pathlib.Path('/cache').is_mount():
 (root/'cache').mkdir()
 mount('--bind','/cache',str(root/'cache'));mount('-o','remount,bind,nosuid,nodev,noexec',str(root/'cache'))
# Expose only guest CPU topology, never cgroup controls or Host resources.
(root/'sys/devices/system/cpu').mkdir(parents=True)
mount('--bind','/sys/devices/system/cpu',str(root/'sys/devices/system/cpu'))
mount('-o','remount,bind,ro,nosuid,nodev,noexec',str(root/'sys/devices/system/cpu'))
mount('-t','proc','-o','nosuid,nodev,noexec,hidepid=2','proc',str(root/'proc'))
mount('-t','tmpfs','-o','size=128m,mode=1777,nosuid,nodev','shm',str(root/'dev/shm'))
for name,major,minor in [('null',1,3),('zero',1,5),('urandom',1,9)]:
 os.mknod(root/'dev'/name,0o20666,os.makedev(major,minor));os.chmod(root/'dev'/name,0o666)
resource.setrlimit(resource.RLIMIT_CORE,(0,0));resource.setrlimit(resource.RLIMIT_NOFILE,(256,256));resource.setrlimit(resource.RLIMIT_FSIZE,(16*1024*1024,16*1024*1024))
if pathlib.Path('/run/'+identity+'.cancel').exists():sys.exit(130)
os.chroot(root);os.chdir('/work');os.setgroups([]);os.setgid(1000);os.setuid(1000)
if ctypes.CDLL(None).prctl(38,1,0,0,0)!=0:raise OSError('no_new_privs')
os.execve('/bin/bash',['bash','--noprofile','--norc','/task.sh'],{'PATH':'/usr/bin:/bin','HOME':'/home','TMPDIR':'/tmp','LANG':'C.UTF-8','PYTHONDONTWRITEBYTECODE':'1','PIP_DISABLE_PIP_VERSION_CHECK':'1','PIP_NO_INDEX':'1','npm_config_offline':'true','PIP_CACHE_DIR':'/cache/pip' if pathlib.Path('/cache').exists() else '/tmp/pip','npm_config_cache':'/cache/npm' if pathlib.Path('/cache').exists() else '/tmp/npm','GIT_CONFIG_NOSYSTEM':'1'})
