# Docker 開発環境管理ツール

ローカル PC の Docker Engine にだけ接続し、コンテナの状態確認・起動・停止・再起動を行う Web アプリです。

Composeラベルを持つ既存コンテナはプロジェクト単位でも表示され、既存コンテナに限って一括起動・停止・再起動できます。一括起動は `created` / `exited`、一括停止・再起動は `running` のコンテナだけを対象にし、対象外の状態と理由は操作前後に表示します。処理は並列で実行し、部分的に失敗しても他の対象は続行します。

これは既存コンテナを束ねる補助操作です。`docker compose up/down`、compose.yamlの探索、依存関係の解釈、コンテナ作成・削除は行いません。

## 起動

1. Docker Desktop / Docker Engine を起動します。
2. `npm install` を実行します。
3. `npm start` を実行し、[http://127.0.0.1:3000](http://127.0.0.1:3000) を開きます。

Docker 接続先は既定で、Windows は `//./pipe/docker_engine`、その他は `/var/run/docker.sock` です。変更する場合は `DOCKER_SOCKET` 環境変数を指定してください。

## テスト

- `npm test`: APIと履歴保存の自動テスト
- `npm run test:e2e`: Chromiumによる主要画面とDocker接続エラー表示のE2Eテスト

## 安全性

- バックエンド経由で Docker Engine API に接続します。ブラウザから Docker ソケットには直接接続しません。
- Web サーバーは `127.0.0.1` でのみ待ち受けます。認証機能はないため、LAN やインターネットへ公開する設定は提供しません。
- 操作対象はローカルの Docker Engine のみです。削除・作成・イメージ変更は実装していません。
- 履歴は `data/history.json` にローカル保存されます（Git 管理対象外）。
