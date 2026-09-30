#!/bin/sh
set -eu
modprobe br_netfilter
sysctl -w net.bridge.bridge-nf-call-iptables=1
sysctl -w net.bridge.bridge-nf-call-ip6tables=1
cd /opt/qa-browser
docker network inspect qa-browser-net >/dev/null 2>&1 || docker network create --subnet 172.29.0.0/24 qa-browser-net
# Block browser-initiated access to the host, tailnet, metadata and private LANs.
iptables -N QA_BROWSER_EGRESS 2>/dev/null || true
iptables -F QA_BROWSER_EGRESS
iptables -A QA_BROWSER_EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
for range in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4; do
  iptables -A QA_BROWSER_EGRESS -d "$range" -j REJECT
done
iptables -A QA_BROWSER_EGRESS -j RETURN
iptables -C DOCKER-USER -s 172.29.0.0/24 -j QA_BROWSER_EGRESS 2>/dev/null || iptables -I DOCKER-USER -s 172.29.0.0/24 -j QA_BROWSER_EGRESS
iptables -C INPUT -s 172.29.0.0/24 -j QA_BROWSER_EGRESS 2>/dev/null || iptables -I INPUT -s 172.29.0.0/24 -j QA_BROWSER_EGRESS
docker rm -f qa-browser >/dev/null 2>&1 || true
browser_uid=$(docker run --rm --network none --entrypoint id qa-browser:pilot -u)
browser_gid=$(docker run --rm --network none --entrypoint id qa-browser:pilot -g)
install -d -o "$browser_uid" -g "$browser_gid" -m 700 /var/lib/qa-browser
exec docker run --rm --name qa-browser --init --network qa-browser-net --ip 172.29.0.2 \
  --memory 2g --memory-swap 2g --cpus 1 --pids-limit 256 --shm-size 512m \
  --security-opt seccomp=/opt/qa-browser/seccomp.json --cap-drop ALL --cap-add SYS_CHROOT \
  --mount type=bind,src=/var/lib/qa-browser,dst=/var/lib/qa-browser -e BROWSER_DATA=/var/lib/qa-browser \
  --env-file /opt/qa-browser/service.env -e BROWSER_MAX_SESSIONS=2 -p 100.122.229.15:8080:8080 qa-browser:pilot
