#!/bin/bash
# /srv/data を毎日まとめて保存し、14日より古いものを消す
set -euo pipefail
f=/srv/backup/data-$(date +%F).tar.gz
tar -czf "$f" -C /srv data
find /srv/backup -name 'data-*.tar.gz' -mtime +14 -delete
echo "$(date '+%F %T') バックアップ: $f ($(du -h "$f" | cut -f1))"
