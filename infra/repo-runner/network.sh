#!/bin/sh
set -eu
modprobe br_netfilter
sysctl -w net.bridge.bridge-nf-call-iptables=1
sysctl -w net.bridge.bridge-nf-call-ip6tables=1
docker network inspect qa-repo-net >/dev/null 2>&1 || docker network create --subnet 172.30.0.0/24 qa-repo-net
iptables -N QA_REPO_EGRESS 2>/dev/null || true
iptables -F QA_REPO_EGRESS
iptables -A QA_REPO_EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
for range in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4; do
  iptables -A QA_REPO_EGRESS -d "$range" -j REJECT
done
iptables -A QA_REPO_EGRESS -j RETURN
iptables -C DOCKER-USER -s 172.30.0.0/24 -j QA_REPO_EGRESS 2>/dev/null || iptables -I DOCKER-USER -s 172.30.0.0/24 -j QA_REPO_EGRESS
iptables -C INPUT -s 172.30.0.0/24 -j QA_REPO_EGRESS 2>/dev/null || iptables -I INPUT -s 172.30.0.0/24 -j QA_REPO_EGRESS
