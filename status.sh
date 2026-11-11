#!/bin/bash
# いまの状態を表示する
IP=$(curl -fsS -4 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
echo "IP: $IP"
for s in /etc/systemd/system/app-*.service; do
  [ -f "$s" ] || continue
  n=$(basename "$s" .service)
  echo "$n: $(systemctl is-active "$n")"
done
echo "caddy: $(systemctl is-active caddy)"
grep -E '^[a-z0-9.-]+\.sslip\.io|^[a-z0-9.-]+\.[a-z]+ ' /etc/caddy/Caddyfile | sed 's/ {$//' | sed 's/^/https:\/\//'
