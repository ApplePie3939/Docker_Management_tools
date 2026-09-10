# Docker 開発環境管理ツール

社内の共有 Docker ホストに接続し、コンテナの状態確認・起動・停止・再起動を行う Web アプリです。利用には、OIDC で認証された許可グループのメンバーであることが必要です。

Composeラベルを持つ既存コンテナはプロジェクト単位でも表示され、既存コンテナに限って一括起動・停止・再起動できます。一括起動は `created` / `exited`、一括停止・再起動は `running` のコンテナだけを対象にし、対象外の状態と理由は操作前後に表示します。処理は並列で実行し、部分的に失敗しても他の対象は続行します。

これは既存コンテナを束ねる補助操作です。`docker compose up/down`、compose.yamlの探索、依存関係の解釈、コンテナ作成・削除は行いません。

## 起動

1. Node.js 24 以上と Docker Engine を用意します。
2. IdP に Web アプリを登録し、以下の環境変数を設定します。
3. `npm install`、続けて `npm start` を実行します。アプリは `127.0.0.1:3000` でのみ待ち受けます。
4. Nginx を HTTPS のみで公開し、[Nginx 設定例](deploy/nginx/docker-management.conf.example) の CIDR・ホスト名・証明書パスを実値に置換します。利用者は Nginx の HTTPS URL へアクセスします。

```text
OIDC_ISSUER=https://idp.example.internal
OIDC_CLIENT_ID=docker-management
OIDC_CLIENT_SECRET=replace-with-a-secret
OIDC_REDIRECT_URI=https://docker-management.internal.example/auth/callback
OIDC_ALLOWED_GROUP=docker-management-users
# IdP がグループを返すクレーム名。未指定時は groups。
OIDC_GROUPS_CLAIM=groups
```

`OIDC_ISSUER`、`OIDC_CLIENT_ID`、`OIDC_CLIENT_SECRET`、`OIDC_REDIRECT_URI`、`OIDC_ALLOWED_GROUP` は必須です。IdP は `sub` と許可グループを ID Token または UserInfo で返す必要があります。ログインセッションは `data/auth.sqlite` に保存され、8 時間で失効します。

Docker 接続先は既定で、Windows は `//./pipe/docker_engine`、その他は `/var/run/docker.sock` です。変更する場合は `DOCKER_SOCKET` 環境変数を指定してください。

## テスト

- `npm test`: API、認証・CSRF、履歴保存の自動テスト
- `npm run test:e2e`: Chromiumによる主要画面とDocker接続エラー表示のE2Eテスト

## 安全性

- バックエンド経由で Docker Engine API に接続します。ブラウザから Docker ソケットには直接接続しません。
- Web サーバーは `127.0.0.1` でのみ待ち受けます。外部公開は Nginx の TLS と社内 CIDR 制限を通す構成だけをサポートします。
- Docker Engine API および Docker ソケットを外部に公開してはいけません。Node プロセスは専用サービスアカウントで実行し、Docker へのアクセス権だけを必要最小限に付与してください。
- 操作対象は共有する開発用 Docker Engine 1 台です。削除・作成・イメージ変更、本番 Docker ホストの管理は実装していません。
- 履歴は `data/history.json`、認証セッションは `data/auth.sqlite` にローカル保存されます（Git 管理対象外）。
