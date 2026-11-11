"""Runs inside a new PID/mount namespace, joins cgroup before entry, drops privilege before code."""
import os,sys,subprocess,pathlib,ctypes,resource
root=pathlib.Path(sys.argv[1]);identity=sys.argv[2];profile=sys.argv[3] if len(sys.argv)>3 else 'shell'
def mount(*args):subprocess.run(['/bin/busybox','mount',*args],check=True,stdin=subprocess.DEVNULL)
mount('--make-rprivate','/')
browserish=profile in ['browser','resident']
if browserish:mount('--bind',str(root),str(root))
for path in ['bin','lib','usr']:
 mount('--bind','/'+path,str(root/path));mount('-o','remount,bind,ro,nosuid,nodev',str(root/path))
# TLS trust store and name of the loopback, read-only: online tools verify certificates themselves.
if pathlib.Path('/etc/ssl').is_dir():
 (root/'etc/ssl').mkdir(parents=True,exist_ok=True)
 mount('--bind','/etc/ssl',str(root/'etc/ssl'));mount('-o','remount,bind,ro,nosuid,nodev,noexec',str(root/'etc/ssl'))
(root/'etc/hosts').write_text('127.0.0.1 localhost\n::1 localhost\n')
# Font configuration, read-only, so the browser can find fallback fonts (CJK) for any text.
if pathlib.Path('/etc/fonts').is_dir():
 (root/'etc/fonts').mkdir(parents=True,exist_ok=True)
 mount('--bind','/etc/fonts',str(root/'etc/fonts'));mount('-o','remount,bind,ro,nosuid,nodev,noexec',str(root/'etc/fonts'))
if profile=='shell' and pathlib.Path('/cache').is_mount():
 (root/'cache').mkdir()
 mount('--bind','/cache',str(root/'cache'));mount('-o','remount,bind,nosuid,nodev,noexec',str(root/'cache'))
# Expose only guest CPU topology, never cgroup controls or Host resources.
(root/'sys/devices/system/cpu').mkdir(parents=True)
mount('--bind','/sys/devices/system/cpu',str(root/'sys/devices/system/cpu'))
mount('-o','remount,bind,ro,nosuid,nodev,noexec',str(root/'sys/devices/system/cpu'))
mount('-t','proc','-o','nosuid,nodev,noexec,hidepid=2','proc',str(root/'proc'))
mount('-t','tmpfs','-o','size=128m,mode=1777,nosuid,nodev','shm',str(root/'dev/shm'))
if profile=='resident':
 # Managed policy: no background traffic of Chromium's own (updates, spellcheck dictionaries,
 # error-page suggestions, Safe Browsing lists). Each would ask the user to approve a site
 # they never opened. Pages still load whatever they need.
 import json
 (root/'etc/chromium/policies/managed').mkdir(parents=True)
 (root/'etc/chromium/policies/managed/nidus.json').write_text(json.dumps({
  'ComponentUpdatesEnabled':False,'SpellcheckEnabled':False,'SpellCheckServiceEnabled':False,
  'SafeBrowsingProtectionLevel':0,'MetricsReportingEnabled':False,'SearchSuggestEnabled':False,
  'NetworkPredictionOptions':2,'TranslateEnabled':False,'AlternateErrorPagesEnabled':False,
  'PasswordLeakDetectionEnabled':False,'UrlKeyedAnonymizedDataCollectionEnabled':False,
  'BrowserSignin':0,'SyncDisabled':True,'DnsOverHttpsMode':'off','QuicAllowed':False,
  'BackgroundModeEnabled':False,'PromotionalTabsEnabled':False,'ShoppingListEnabled':False,
  # The default search engine preconnects to it and checks address-bar AI features.
  # The AI opens addresses directly; there is no address bar to search from.
  'DefaultSearchProviderEnabled':False,'AIModeSettings':1}))
 # Session space is a small tmpfs. The browser gets its own scratch space, and its profile
 # (cookies, sign-ins) lives on the Vault's cache disk when one is attached.
 mount('-t','tmpfs','-o','size=512m,mode=1777,nosuid,nodev','browser-tmp',str(root/'tmp'))
 if pathlib.Path('/browser-profile').is_dir() and not pathlib.Path('/browser-profile').is_symlink():
  mount('--bind','/browser-profile',str(root/'home'));mount('-o','remount,bind,nosuid,nodev,noexec',str(root/'home'))
 else:
  mount('-t','tmpfs','-o','size=256m,mode=700,uid=1000,gid=1000,nosuid,nodev','browser-home',str(root/'home'))
for name,major,minor in [('null',1,3),('zero',1,5),('urandom',1,9)]:
 os.mknod(root/'dev'/name,0o20666,os.makedev(major,minor));os.chmod(root/'dev'/name,0o666)
resource.setrlimit(resource.RLIMIT_CORE,(0,0));resource.setrlimit(resource.RLIMIT_NOFILE,(256,256));resource.setrlimit(resource.RLIMIT_FSIZE,(16*1024*1024,16*1024*1024))
if pathlib.Path('/run/'+identity+'.cancel').exists():sys.exit(130)
# Online through the host's Egress Proxy when the relay runs; the VM's own loopback stays direct.
EGRESS=profile=='shell' and pathlib.Path('/run/egress').exists()
PROXY='http://127.0.0.1:3128';NO_PROXY='localhost,127.0.0.1,::1,.localhost'
if browserish:
 (root/'.old-root').mkdir();os.chdir(root)
 libc=ctypes.CDLL(None,use_errno=True)
 if libc.syscall(41,b'.',b'.old-root')!=0:raise OSError(ctypes.get_errno(),'pivot_root')
 os.chroot('.');os.chdir('/')
 subprocess.run(['/bin/busybox','umount','-l','/.old-root'],check=True);os.rmdir('/.old-root')
else:os.chroot(root)
os.chdir('/work');os.setgroups([]);os.setgid(1000);os.setuid(1000)
if ctypes.CDLL(None).prctl(38,1,0,0,0)!=0:raise OSError('no_new_privs')
os.execve('/bin/bash',['bash','--noprofile','--norc','/task.sh'],{'PATH':'/usr/bin:/bin','HOME':'/home','TMPDIR':'/tmp','LANG':'C.UTF-8','PYTHONDONTWRITEBYTECODE':'1','PIP_DISABLE_PIP_VERSION_CHECK':'1',**({'HTTP_PROXY':PROXY,'HTTPS_PROXY':PROXY,'http_proxy':PROXY,'https_proxy':PROXY,'NO_PROXY':NO_PROXY,'no_proxy':NO_PROXY} if EGRESS else {'PIP_NO_INDEX':'1','npm_config_offline':'true'}),'PIP_CACHE_DIR':'/cache/pip' if pathlib.Path('/cache').exists() else '/tmp/pip','npm_config_cache':'/cache/npm' if pathlib.Path('/cache').exists() else '/tmp/npm','GIT_CONFIG_NOSYSTEM':'1'})
