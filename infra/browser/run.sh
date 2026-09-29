#!/bin/sh
set -eu
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
exec docker run --rm --name qa-browser --init --network qa-browser-net --ip 172.29.0.2 \
  --memory 3g --cpus 2 --pids-limit 256 --shm-size 512m \
  --security-opt seccomp=/opt/qa-browser/seccomp.json --cap-drop ALL --cap-add SYS_CHROOT \
  --env-file /opt/qa-browser/service.env -p 100.122.229.15:8080:8080 qa-browser:pilot
