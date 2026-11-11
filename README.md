# app-server

ConoHa VPS（Ubuntu 24.04）で動かすアプリ用サーバー一式。アプリごとに `apps/<名前>/` を置くと、
https の住所（`<名前>.<IPをハイフンでつないだもの>.sslip.io`）と常駐サービスが自動でできる。

## はじめの1回
ConoHa のコンソールで root にログインして、次を実行する。

    curl -fsSL https://raw.githubusercontent.com/cfukuwork-afk/app-server/main/setup.sh | bash

## そのあと
- GitHub の main に入れた変更は、5分以内にサーバーへ自動で反映される（update.sh）
- データは /srv/data/<アプリ名>/、毎日 4:10 に /srv/backup/ へ保存（14日分）
- 状態の確認: `bash /opt/app-server/status.sh`

## アプリを足すとき
`apps/<名前>/app.conf`（NAME・PORT・HOSTS）と `apps/<名前>/server.js` を置くだけ。
パスワードや鍵、個人の連絡先はこのリポジトリに入れない（公開リポジトリのため）。

## アプリ一覧
| 名前 | 住所 | 内容 |
|---|---|---|
| tripfold | https://tripfold.160-251-171-249.sslip.io | 旅行の共有（共同編集・写真）、場所探しの使い回し |
