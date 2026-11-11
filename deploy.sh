#!/bin/bash
# apps/*/app.conf を読んで、アプリごとに常駐サービスと https の住所を作る
set -euo pipefail
ROOT=/opt/app-server
IP=$(curl -fsS -4 https://api.ipify.org || hostname -I | awk '{print $1}')
DASHIP=${IP//./-}
CADDY=/etc/caddy/Caddyfile
TMP=$(mktemp)
echo "# このファイルは deploy.sh が自動で作ります。直接は編集しないでください" > "$TMP"
for conf in "$ROOT"/apps/*/app.conf; do
  [ -f "$conf" ] || continue
  dir=$(dirname "$conf")
  NAME=""; PORT=""; HOSTS=""
  # shellcheck disable=SC1090
  source "$conf"
  [ -n "$NAME" ] && [ -n "$PORT" ] || continue
  HOSTS=${HOSTS:-"$NAME.$DASHIP.sslip.io"}
  HOSTS=${HOSTS//\{ip\}/$DASHIP}
  mkdir -p "/srv/data/$NAME"
  chown -R apps:apps "/srv/data/$NAME"
  cat > "/etc/systemd/system/app-$NAME.service" <<UNIT
[Unit]
Description=app $NAME
After=network.target

[Service]
User=apps
WorkingDirectory=$dir
Environment=PORT=$PORT
Environment=DATA_DIR=/srv/data/$NAME
Environment=NODE_ENV=production
ExecStart=/usr/bin/node $dir/server.js
Restart=always
RestartSec=3
MemoryMax=300M
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=/srv/data/$NAME

[Install]
WantedBy=multi-user.target
UNIT
  echo "$HOSTS {
	encode gzip
	request_body {
		max_size 25MB
	}
	reverse_proxy 127.0.0.1:$PORT
}" >> "$TMP"
  systemctl daemon-reload
  systemctl enable "app-$NAME" >/dev/null 2>&1 || true
  systemctl restart "app-$NAME"
  echo "起動: $NAME → https://${HOSTS%% *}"
done
if ! cmp -s "$TMP" "$CADDY"; then
  cp "$TMP" "$CADDY"
  systemctl reload caddy || systemctl restart caddy
fi
rm -f "$TMP"
