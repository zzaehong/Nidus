#!/bin/sh
/usr/bin/busybox --install -s /bin
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t devtmpfs devtmpfs /dev
modprobe virtio_pci
modprobe virtio_console
modprobe virtiofs
modprobe virtio_net
mkdir -p /workspace /tmp
mount -t virtiofs workspace /workspace || { echo MOUNT_FAILED; exec sleep 40; }
echo "NIDUS_BOOT $(uname -r)"
cat /proc/cmdline
ls /sys/class/net
if [ -e /sys/class/net/eth0 ]; then
    ip link set eth0 up
    ip addr add 192.0.2.2/24 dev eth0
    arp -s 192.0.2.1 02:00:00:00:00:01
    arp -s 192.0.2.3 02:00:00:00:00:03
else
    ping -c 1 -W 1 192.0.2.1 >/tmp-network-check 2>&1
    [ "$?" -ne 0 ] && echo DEFAULT_NETWORK_BLOCKED
fi
# Fixed fixture only. The only host mount is the disposable copy.
[ ! -e /workspace/.nidus ] && [ ! -e /workspace/.git ] && [ ! -e /workspace/.env ] && echo SECRET_PATHS_ABSENT
[ ! -e /Users ] && [ ! -e /host ] && echo HOST_PATHS_ABSENT
[ -z "$NIDUS_FIXTURE_SECRET" ] && echo ENV_SECRET_ABSENT
cat /workspace/input.txt
printf 'fixture result\n' > /workspace/result.txt
ln -s /host-secret /workspace/escape.txt
ln /workspace/input.txt /workspace/hard.txt
[ ! -e /workspace/../original/.env ] && echo PARENT_ESCAPE_BLOCKED
cat > /tmp/beat <<'BEAT'
#!/bin/sh
while :; do
    printf . >> /workspace/heartbeat
    if [ -e /sys/class/net/eth0 ]; then
        printf approved | nc -u -w 1 192.0.2.1 9000 &
        printf forbidden | nc -u -w 1 192.0.2.3 9001 &
    fi
    sleep 0.1
done
BEAT
chmod +x /tmp/beat
mode=$(sed -n 's/.*nidus_mode=\([^ ]*\).*/\1/p' /proc/cmdline)
case "$mode" in
ordinary) /tmp/beat & ;;
setsid) setsid /tmp/beat & ;;
double-fork) setsid sh -c 'sh -c "/tmp/beat &" &' & ;;
nested) setsid sh -c '/tmp/beat & /tmp/beat & wait' & ;;
esac
echo WORKLOAD_STARTED
# PID 1 deliberately ignores graceful shutdown; forceStop must not depend on guest cooperation.
while :; do sleep 1; done
