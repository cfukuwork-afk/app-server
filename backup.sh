#!/bin/bash
# /srv/data を毎日まとめて保存し、14日より古いものを消す
# SkyLab の生データ（増え続ける・すでに圧縮済み・書き換えない）は毎日のまとめから外し、日付フォルダごとに1回だけ複製する
set -euo pipefail
f=/srv/backup/data-$(date +%F).tar.gz
tar -czf "$f" -C /srv --exclude='data/skylab/raw' data
find /srv/backup -name 'data-*.tar.gz' -mtime +14 -delete
echo "$(date '+%F %T') バックアップ: $f ($(du -h "$f" | cut -f1))"
if [ -d /srv/data/skylab/raw ]; then
  mkdir -p /srv/backup/skylab-raw
  for d in /srv/data/skylab/raw/*/; do
    n=$(basename "$d")
    # 今日の分はまだ増えるので、前日までの分だけ複製する
    [ "$n" = "$(date -u +%F)" ] && continue
    [ -e "/srv/backup/skylab-raw/$n.tar" ] || tar -cf "/srv/backup/skylab-raw/$n.tar" -C /srv/data/skylab/raw "$n"
  done
  echo "$(date '+%F %T') SkyLab 生データの複製: $(ls /srv/backup/skylab-raw | wc -l) 日分 ($(du -sh /srv/backup/skylab-raw | cut -f1))"
fi
