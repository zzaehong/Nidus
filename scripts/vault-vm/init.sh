#!/bin/busybox sh
/bin/busybox --install -s /bin
export PATH=/bin:/sbin
mkdir -p /proc /sys /dev /run /sessions
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t devtmpfs devtmpfs /dev
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
echo 'NIDUS_READY cgroup2'
while read -r action id payload seconds; do
 case "$action" in
  probe) echo "NIDUS_PROBE $id $(cat "$CG/cgroup.controllers")" ;;
  execute)
    case "$id" in ''|*[!a-zA-Z0-9-]*) echo 'NIDUS_REJECT id'; continue;; esac
    case "$seconds" in ''|*[!0-9]*) echo 'NIDUS_REJECT timeout'; continue;; esac
    if test "$seconds" -gt 60 || test "$seconds" -lt 1 || test -e /run/busy; then echo 'NIDUS_REJECT busy'; continue; fi
    touch /run/busy
    run_session "$id" "$payload" "$seconds" &
    ;;
  cancel) case "$id" in ''|*[!a-zA-Z0-9-]*) continue;; esac
    touch "/run/$id.cancel"; if test -d "$CG/$id"; then echo 1 > "$CG/$id/cgroup.kill"; fi ;;
  stop) poweroff -f ;;
 esac
done < /dev/hvc0
while :; do sleep 60; done
