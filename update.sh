#!/bin/bash
# GitHub に新しい変更があれば取り込んで、アプリを再起動する
set -euo pipefail
cd /opt/app-server
# メール受け取り用に、Caddy が取った tripfold.net の証明書をアプリのデータ置き場へコピー（更新されたときだけ）
CERT=$(find /var/lib/caddy -name 'tripfold.net.crt' 2>/dev/null | head -1 || true)
if [ -n "$CERT" ] && [ -d /srv/data/tripfold ]; then
  mkdir -p /srv/data/tripfold/tls
  if ! cmp -s "$CERT" /srv/data/tripfold/tls/cert.pem; then
    cp "$CERT" /srv/data/tripfold/tls/cert.pem
    cp "${CERT%.crt}.key" /srv/data/tripfold/tls/key.pem
    chown -R apps:apps /srv/data/tripfold/tls
    chmod 600 /srv/data/tripfold/tls/key.pem
  fi
fi
git fetch -q origin main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  git reset -q --hard origin/main
  echo "$(date '+%F %T') 更新: $(git log -1 --format=%s)"
  bash deploy.sh
fi
