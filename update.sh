#!/bin/bash
# GitHub に新しい変更があれば取り込んで、アプリを再起動する
set -euo pipefail
cd /opt/app-server
git fetch -q origin main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  git reset -q --hard origin/main
  echo "$(date '+%F %T') 更新: $(git log -1 --format=%s)"
  bash deploy.sh
fi
