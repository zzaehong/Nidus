#!/bin/busybox sh
/bin/busybox --install -s /bin
export PATH=/bin:/sbin
# Give browser namespaces a real mount-tree root rather than an initramfs chroot.
# Keep the immutable development layer by bind mount; never copy it into RAM twice.
if test -d /opt/development && test "$1" != rooted; then
 mkdir /newroot
 mount -t tmpfs -o mode=755 tmpfs /newroot || exit 1
 cp -a /bin /sbin /lib /usr /init /newroot/ || exit 1
 mkdir -p /newroot/opt /newroot/dev
 mount --bind /opt /newroot/opt || exit 1
 cd /newroot || exit 1
 mount --move . / || exit 1
 exec chroot . /init rooted
fi
mkdir -p /proc /sys /dev /run /sessions
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t devtmpfs devtmpfs /dev
# Loopback only: there is no network device. The egress relay listens here.
ip link set lo up 2>/dev/null || ifconfig lo 127.0.0.1 up
stty -F /dev/hvc0 raw -echo || { echo NIDUS_BLOCKED terminal; exec sleep 86400; }
# No unprivileged user namespaces; only the root supervisor creates isolation boundaries.
echo 0 > /proc/sys/user/max_user_namespaces || { echo NIDUS_BLOCKED userns; exec sleep 86400; }
mount -t tmpfs -o mode=700,size=16m tmpfs /run
mount -t tmpfs -o mode=700,size=32m tmpfs /sessions
mkdir -p /sys/fs/cgroup
mount -t cgroup2 none /sys/fs/cgroup
CG=/sys/fs/cgroup
if ! test -f "$CG/cgroup.controllers"; then echo 'NIDUS_BLOCKED cgroup2'; exec sleep 86400; fi
# Root supervisor never belongs to an untrusted session cgroup.
echo '+cpu +memory +pids' > "$CG/cgroup.subtree_control" || { echo 'NIDUS_BLOCKED controllers'; exec sleep 86400; }
run_session() {
 id="$1"; encoded="$2"; seconds="$3"; cg="$CG/$id"; root="/sessions/$id"
 mkdir "$cg" "$root" || return
 echo 134217728 > "$cg/memory.max" || return
 echo 32 > "$cg/pids.max" || return
 echo '50000 100000' > "$cg/cpu.max" || return
 mkdir -p "$root/bin" "$root/lib" "$root/dev" "$root/work" "$root/tmp" "$root/home" "$root/etc"
 cp -a /bin/busybox "$root/bin/" || return; cp -a /lib/. "$root/lib/" || return
 printf 'nidus:x:1000:1000:Session:/home:/bin/sh\nroot:x:0:0:root:/:/bin/sh\n' > "$root/etc/passwd"
 printf 'nidus:x:1000:\nroot:x:0:\n' > "$root/etc/group"
 for app in id su setpriv sh ls cat echo printf sleep mkdir touch rm pwd env setsid head tail wc find tr sort uniq grep sed awk true false kill; do ln -s busybox "$root/bin/$app"; done
 mknod "$root/dev/null" c 1 3; mknod "$root/dev/zero" c 1 5; mknod "$root/dev/urandom" c 1 9
 chmod 666 "$root/dev/"*
 chown 1000:1000 "$root/work" "$root/tmp" "$root/home"
 printf '%s' "$encoded" | base64 -d > "$root/task.sh" || return
 chmod 444 "$root/task.sh"
 # Only the trusted supervisor can write cgroup control files. All descendants inherit membership.
 /bin/sh -c 'echo $$ > "$1/cgroup.procs" || exit 125; test ! -e "$3" || exit 130; ulimit -f 128 || exit 125; ulimit -n 64 || exit 125; ulimit -c 0 || exit 125; exec chroot "$2" /bin/su -s /bin/sh -c "cd /work && exec /bin/env -i PATH=/bin HOME=/home TMPDIR=/tmp /bin/setpriv --no-new-privs /bin/sh /task.sh" nidus' sh "$cg" "$root" "/run/$id.cancel" >"/run/$id.out" 2>"/run/$id.err" </dev/null &
 pid=$!
 echo "NIDUS_SESSION $id started"
 ticks=0; limit=$((seconds*50))
 while kill -0 "$pid" 2>/dev/null; do
   if test "$ticks" -ge "$limit"; then touch "/run/$id.timeout"; echo 1 > "$cg/cgroup.kill"; break; fi
   sleep 0.02; ticks=$((ticks+1))
 done
 wait "$pid"; status=$?
 # Main command exit is not cleanup proof: kill all reparented/setsid/double-fork descendants.
 echo 1 > "$cg/cgroup.kill"
 clean=0; n=0
 while test "$n" -lt 100; do
   if grep -q '^populated 0$' "$cg/cgroup.events"; then clean=1; break; fi
   sleep 0.02; n=$((n+1))
 done
 peak=$(cat "$cg/memory.peak")
 out=$(head -c 32768 "/run/$id.out" | base64 | tr -d '\n'); err=$(head -c 32768 "/run/$id.err" | base64 | tr -d '\n')
 test -n "$out" || out=-; test -n "$err" || err=-
 reason=completed; test -e "/run/$id.timeout" && reason=timeout; test -e "/run/$id.cancel" && reason=cancelled
 if test "$clean" = 1; then
   rmdir "$cg" || clean=0
   rm -rf "$root" || clean=0
 fi
 # Never accept another session if cleanup cannot be established.
 if test "$clean" = 1; then rm -f /run/busy; fi
 rm -f "/run/$id.out" "/run/$id.err" "/run/$id.timeout" "/run/$id.cancel"
 echo "NIDUS_RESULT $id $status $clean $reason $peak $out $err"
}
if test -d /opt/development; then
 # Alpine's install hooks never ran (the image is built on the host), so most BusyBox command
 # links are missing (base64, dirname, tail, seq, du, ...). Link every applet the root lacks.
 for applet in $(chroot /opt/development /bin/busybox --list 2>/dev/null); do
  case "$applet" in *[!a-z0-9_.-]*|'') continue;; esac
  for dir in bin sbin usr/bin usr/sbin; do test -e "/opt/development/$dir/$applet" && continue 2; done
  ln -s /bin/busybox "/opt/development/usr/bin/$applet"
 done
 mount --bind /opt/development /opt/development || { echo NIDUS_BLOCKED development-root; exec sleep 86400; }
 for path in proc sys dev run sessions; do
  mkdir -p "/opt/development/$path"
  mount --bind "/$path" "/opt/development/$path" || { echo NIDUS_BLOCKED development; exec sleep 86400; }
 done
 mount --bind /sys/fs/cgroup /opt/development/sys/fs/cgroup || { echo NIDUS_BLOCKED cgroup-view; exec sleep 86400; }
 echo NIDUS_DEVELOPMENT ready
fi
# Only Host-managed block storage; original Vault is never attached.
cache_mode=; disk_id=
for option in $(cat /proc/cmdline); do
 case "$option" in nidus_cache=*) cache_mode="${option#*=}";; nidus_disk=*) disk_id="${option#*=}";; esac
done
if test -n "$cache_mode"; then
 modprobe virtio_blk; modprobe ext4
 n=0; while ! test -b /dev/vda && test "$n" -lt 100; do sleep .05; n=$((n+1)); done
 if ! test -b /dev/vda || ! test -d /opt/development; then echo NIDUS_BLOCKED cache-device; exec sleep 86400; fi
 if test "$cache_mode" = new; then
  chroot /opt/development /sbin/mke2fs -q -t ext4 -F -m 0 -E lazy_itable_init=0,lazy_journal_init=0 /dev/vda || { echo NIDUS_BLOCKED cache-format; exec sleep 86400; }
 else
  chroot /opt/development /sbin/e2fsck -fn /dev/vda || { echo NIDUS_BLOCKED cache-filesystem; exec sleep 86400; }
 fi
 mkdir -p /persistent /opt/development/cache
 mount -t ext4 -o nosuid,nodev,noexec /dev/vda /persistent > /run/cache-mount.log 2>&1 || { echo NIDUS_BLOCKED cache-mount "$(cat /run/cache-mount.log)" "$(dmesg | tail -n 3)"; exec sleep 86400; }
 if test "$cache_mode" = new; then
  echo "$disk_id" > /persistent/owner-id
  mkdir /persistent/packages; chown 1000:1000 /persistent/packages; chmod 700 /persistent/packages
 fi
 if ! test "$(cat /persistent/owner-id)" = "$disk_id" || ! test -d /persistent/packages || test -L /persistent/packages; then echo NIDUS_BLOCKED cache-owner; exec sleep 86400; fi
 mount --bind /persistent/packages /opt/development/cache || { echo NIDUS_BLOCKED cache-view; exec sleep 86400; }
 # The workspace browser's profile (cookies, sign-ins) survives VM restarts on the same disk.
 if ! test -e /persistent/browser; then mkdir /persistent/browser && chown 1000:1000 /persistent/browser && chmod 700 /persistent/browser; fi
 if test -d /persistent/browser && ! test -L /persistent/browser; then
  mkdir -p /opt/development/browser-profile
  mount --bind /persistent/browser /opt/development/browser-profile || { echo NIDUS_BLOCKED browser-profile; exec sleep 86400; }
 fi
 # Task workspaces (Git repositories the AI works in) survive VM restarts on the same disk.
 # Executable, unlike the package cache: build tools run scripts from the workspace.
 if ! test -e /persistent/workspaces; then mkdir -m 755 /persistent/workspaces; fi
 if test -d /persistent/workspaces && ! test -L /persistent/workspaces; then
  mkdir -p /opt/development/workspaces
  mount --bind /persistent/workspaces /opt/development/workspaces && mount -o remount,bind,nosuid,nodev,exec /opt/development/workspaces || { echo NIDUS_BLOCKED workspaces; exec sleep 86400; }
 fi
 echo NIDUS_CACHE_READY
fi
# Without a cache disk, workspaces live in memory until the VM stops.
test -d /opt/development && mkdir -p -m 755 /opt/development/workspaces
# The only way out: a virtio console port to the host's Egress Proxy. Restarted if it dies.
if test -d /opt/development && grep -qx nidus.egress /sys/class/virtio-ports/*/name 2>/dev/null; then
 ( while :; do
    chroot /opt/development /usr/bin/python3 /nidus/egress-relay.py >/run/egress.log 2>&1
    echo "NIDUS_EGRESS exited $? $(tail -c 400 /run/egress.log | tr '\n' ' ')"
    sleep 1
   done ) &
 # Report ready only once the relay accepts connections (3128 = 0x0C38 in /proc/net/tcp).
 n=0; while ! grep -q ':0C38 00000000:0000 0A' /proc/net/tcp && test "$n" -lt 200; do sleep 0.05; n=$((n+1)); done
 touch /run/egress
 echo NIDUS_EGRESS relay
fi
echo 'NIDUS_READY cgroup2'
while read -r action id payload seconds snapshot; do
 case "$action" in
  probe) echo "NIDUS_PROBE $id $(cat "$CG/cgroup.controllers")" ;;
  workspace-begin|workspace-chunk|workspace-seal)
    if test -e /run/busy || ! test -d /opt/development; then echo 'NIDUS_REJECT busy'; continue; fi
    chroot /opt/development /usr/bin/python3 /nidus/workspace.py "${action#workspace-}" "$id" "$payload" || echo 'NIDUS_REJECT workspace'
    ;;
  browser-input)
    case "$id" in ''|*[!a-f0-9-]*) continue;; esac
    if test -p "/run/$id.input"; then printf '%s\n' "$payload" > "/run/$id.input"; fi
    ;;
  service-start)
    # A background process (dev server, watcher) beside Shell sessions; at most four.
    case "$id" in ''|*[!a-f0-9-]*) echo 'NIDUS_REJECT id'; continue;; esac
    case "$seconds" in ''|*[!0-9]*) echo "NIDUS_REJECT service $id"; continue;; esac
    if ! test -d /opt/development || test "$(ls /run | grep -c '^service-')" -ge 4; then echo "NIDUS_REJECT service $id"; continue; fi
    touch "/run/service-$id"
    chroot /opt/development /usr/bin/python3 /nidus/session.py "$id" "$payload" "$seconds" service &
    ;;
  workspace-import|workspace-export)
    # id: task name, payload: one-time transfer token, seconds: size, snapshot: sha256 or base commit.
    case "$id" in ''|*[!a-z0-9-]*) echo 'NIDUS_REJECT id'; continue;; esac
    if ! test -d /opt/development || ! test -e /run/egress; then echo "NIDUS_WORKSPACE_FAILED $id unavailable"; continue; fi
    if test "$action" = workspace-import; then
     chroot /opt/development /usr/bin/python3 /nidus/workspace-sync.py import "$id" "$payload" "$seconds" "$snapshot" &
    else
     chroot /opt/development /usr/bin/python3 /nidus/workspace-sync.py export "$id" "$payload" "$snapshot" &
    fi
    ;;
  workspace-remove)
    case "$id" in ''|*[!a-z0-9-]*) echo 'NIDUS_REJECT id'; continue;; esac
    rm -rf "/opt/development/workspaces/$id"
    if test "$(cat /run/workspace-current 2>/dev/null)" = "$id"; then rm -f /run/workspace-current; fi
    echo "NIDUS_WORKSPACE_REMOVED $id"
    ;;
  workspace-select)
    # After a VM restart: the task's workspace is still on the disk; make it current again.
    case "$id" in ''|*[!a-z0-9-]*) echo 'NIDUS_REJECT id'; continue;; esac
    if test -d "/opt/development/workspaces/$id/.git" && ! test -L "/opt/development/workspaces/$id"; then printf '%s' "$id" > /run/workspace-current; echo "NIDUS_WORKSPACE_SELECTED $id"; else echo "NIDUS_WORKSPACE_FAILED $id missing"; fi
    ;;
  browser-start)
    # The resident workspace browser: beside Shell sessions, one at a time, needs the link.
    case "$id" in ''|*[!a-f0-9-]*) echo 'NIDUS_REJECT id'; continue;; esac
    case "$seconds" in ''|*[!0-9]*) echo "NIDUS_REJECT browser $id"; continue;; esac
    if test -e /run/browser || ! test -d /opt/development || ! test -e /run/egress; then echo "NIDUS_REJECT browser $id"; continue; fi
    touch /run/browser
    unshare -m -f /bin/sh -c 'mount --make-rprivate / && cd /opt/development && mkdir -p .old-root && pivot_root . .old-root && /bin/busybox umount -l /.old-root && exec /usr/bin/python3 /nidus/session.py "$@"' sh "$id" - "$seconds" resident &
    ;;
  execute-dev|execute-browser|browser-open)
    case "$id" in ''|*[!a-f0-9-]*) echo 'NIDUS_REJECT id'; continue;; esac
    if test -e /run/busy || ! test -d /opt/development; then echo 'NIDUS_REJECT busy'; continue; fi
    touch /run/busy
    profile=shell; test "$action" = execute-browser && profile=browser
    if test "$action" = browser-open; then profile=interactive; seconds=900; snapshot=; mkfifo "/run/$id.input" || exit 1; fi
    if test "$profile" != shell; then
     # pivot the namespace root before entering Python: a chroot ancestor blocks
     # Chromium's unprivileged user namespace even after the session pivot.
     unshare -m -f /bin/sh -c 'mount --make-rprivate / && cd /opt/development && mkdir -p .old-root && pivot_root . .old-root && /bin/busybox umount -l /.old-root && exec /usr/bin/python3 /nidus/session.py "$@"' sh "$id" "$payload" "$seconds" "$profile" "$snapshot" &
    else
     chroot /opt/development /usr/bin/python3 /nidus/session.py "$id" "$payload" "$seconds" "$profile" "$snapshot" &
    fi
    ;;
  execute)
    case "$id" in ''|*[!a-zA-Z0-9-]*) echo 'NIDUS_REJECT id'; continue;; esac
    case "$seconds" in ''|*[!0-9]*) echo 'NIDUS_REJECT timeout'; continue;; esac
    if test "$seconds" -gt 60 || test "$seconds" -lt 1 || test -e /run/busy; then echo 'NIDUS_REJECT busy'; continue; fi
    touch /run/busy
    run_session "$id" "$payload" "$seconds" &
    ;;
  cancel) case "$id" in ''|*[!a-zA-Z0-9-]*) continue;; esac
    touch "/run/$id.cancel"; if test -d "$CG/$id"; then echo 1 > "$CG/$id/cgroup.kill"; fi ;;
  stop)
    if test -e /run/busy || test -e /run/browser || ls /run | grep -q '^service-'; then echo NIDUS_REJECT busy; continue; fi
    if test -n "$cache_mode"; then
     sync
     if mountpoint -q /opt/development/browser-profile; then umount /opt/development/browser-profile || { echo NIDUS_BLOCKED cache-unmount; continue; }; fi
     if mountpoint -q /opt/development/workspaces; then umount /opt/development/workspaces || { echo NIDUS_BLOCKED cache-unmount; continue; }; fi
     umount /opt/development/cache && umount /persistent || { echo NIDUS_BLOCKED cache-unmount; continue; }
     echo NIDUS_CACHE_CLEAN
    fi
    poweroff -f ;;
 esac
done < /dev/hvc0
while :; do sleep 60; done
