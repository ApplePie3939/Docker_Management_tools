# Docker 開発環境管理ツール

ローカル PC の Docker Engine にだけ接続し、コンテナの状態確認・起動・停止・再起動を行う Web アプリです。

## 起動

1. Docker Desktop / Docker Engine を起動します。
2. `npm install` を実行します。
3. `npm start` を実行し、[http://127.0.0.1:3000](http://127.0.0.1:3000) を開きます。

Docker 接続先は既定で、Windows は `//./pipe/docker_engine`、その他は `/var/run/docker.sock` です。変更する場合は `DOCKER_SOCKET` 環境変数を指定してください。

## 安全性

- バックエンド経由で Docker Engine API に接続します。ブラウザから Docker ソケットには直接接続しません。
- Web サーバーは `127.0.0.1` でのみ待ち受けます。認証機能はないため、LAN やインターネットへ公開する設定は提供しません。
- 操作対象はローカルの Docker Engine のみです。削除・作成・イメージ変更は実装していません。
- 履歴は `data/history.json` にローカル保存されます（Git 管理対象外）。
