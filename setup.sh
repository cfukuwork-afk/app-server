#!/bin/bash
# アプリ用サーバーの初期設定（Ubuntu 24.04 を作り直した直後に1回だけ実行）
#   curl -fsSL https://raw.githubusercontent.com/cfukuwork-afk/app-server/main/setup.sh | bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "== 1/6 パッケージを最新に =="
apt-get update -y
apt-get upgrade -y
apt-get install -y curl git ufw ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https unattended-upgrades

echo "== 2/6 Node.js 22 =="
if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "== 3/6 Caddy（https の鍵を自動で取って、アプリに振り分ける） =="
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo "== 4/6 ファイアウォール（Web だけ開ける） =="
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

echo "== 5/6 コードを取得 =="
id apps >/dev/null 2>&1 || useradd --system --home /srv/apps --shell /usr/sbin/nologin apps
mkdir -p /srv/data /srv/backup /srv/apps
chown -R apps:apps /srv/data /srv/apps
if [ ! -d /opt/app-server/.git ]; then
  git clone https://github.com/cfukuwork-afk/app-server /opt/app-server
else
  git -C /opt/app-server pull --ff-only
fi

echo "== 6/6 アプリを起動し、自動更新・毎日のバックアップを設定 =="
bash /opt/app-server/deploy.sh
cat > /etc/cron.d/app-server <<'CRON'
# GitHub の更新を5分ごとに取り込む
*/5 * * * * root bash /opt/app-server/update.sh >> /var/log/app-server-update.log 2>&1
# 毎日 4:10 にデータをバックアップ（14日分）
10 4 * * * root bash /opt/app-server/backup.sh >> /var/log/app-server-backup.log 2>&1
CRON
chmod 644 /etc/cron.d/app-server

echo
echo "完了しました。"
bash /opt/app-server/status.sh
