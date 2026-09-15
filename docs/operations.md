# 運用・デプロイ・復元

この文書は、EdgePhotos v1 のセットアップ、更新、backup / restore、uninstall の運用契約を定義します。

> **検証状況:** 以下のうち local（Miniflare / `vite dev` / `vite preview`）で確認したのは、migration 適用、fail-closed、upload → timeline → album → share → revoke、export / restore / verify のロジックです。実 Cloudflare 環境（Access application、R2 presigned URL と CORS、remote D1 migration、デプロイ）での手順は **未検証** です。初回の remote-test 環境構築時に実測し、この文書を更新してください。

## 1. セットアップ目標

安全性を下げて完全ワンクリックを目指すのではなく、利用者が自分の Cloudflare account に必要な設定を明示的に確認できる構成にします。

```text
1. Create D1 / R2 and deploy the Worker
2. Configure Cloudflare Access
3. Configure R2 signing credentials and CORS
4. Open EdgePhotos and verify setup
```

Deploy to Cloudflare ボタンは Release polish の範囲です（roadmap）。

## 2. リソース作成とデプロイ（未検証の想定手順）

環境ごとに D1・R2・Access application・R2 credential を分けます。以下は `remote-test` の例です。production は `--env` を外し、`wrangler.jsonc` の top-level 設定を使います。

```bash
pnpm wrangler d1 create edgephotos-remote-test
pnpm wrangler r2 bucket create edgephotos-remote-test
# D1 の database_id を wrangler.jsonc の env.remote-test.d1_databases に記入する
# (または wrangler の自動 provisioning を使う)

pnpm wrangler d1 migrations apply DB --env remote-test --remote
CLOUDFLARE_ENV=remote-test pnpm build
pnpm wrangler deploy --config dist/edgephotos/wrangler.json
```

R2 bucket は public access（r2.dev / custom domain）を有効にしません。

migration は forward-only です。通常の test command から remote migration は実行しません。

## 3. 利用者が明示設定するもの

Vars（`wrangler.jsonc` の `vars`、空文字のままだと private API は `503` で fail-closed）:

| 名前 | 例 | 用途 |
| --- | --- | --- |
| `OWNER_EMAIL` | `you@example.com` | owner として許可する Access identity |
| `APP_ORIGIN` | `https://photos.example.com` | 共有 URL 生成、Origin check |
| `ACCESS_TEAM_DOMAIN` | `yourteam.cloudflareaccess.com` | JWT issuer / JWKS |
| `ACCESS_AUD` | Access application の AUD tag | JWT audience |
| `R2_ACCOUNT_ID` | 32 桁 hex | presigned URL の S3 endpoint |
| `R2_BUCKET_NAME` | `edgephotos` | presigned URL の bucket |

Secrets（`wrangler secret put`）:

```text
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
```

R2 credential は対象 bucket だけの Object Read & Write 権限を持つ R2 API token から作成します。Cloudflare account 全体を管理できる token を EdgePhotos へ設定しません。

## 4. Cloudflare Access

同じ hostname に 2 つの Access application を作ります。

1. `photos.example.com/*`: Allow policy（owner の identity のみ）
2. `photos.example.com/share/*`: Bypass policy

1 の AUD tag を `ACCESS_AUD` に設定します。Access を通過しても `OWNER_EMAIL` と一致しない identity は Worker が `403` にします。

`/share/assets/*`（build 済み JS / CSS）も Bypass 側に含まれます（[D-011](decisions.md)）。

## 5. APP_ORIGIN

`APP_ORIGIN` は明示設定します。受信した `Host` header から正規 origin を自己決定しません。

Custom domain は v1 の必須条件ではありません。custom domain を追加した場合は Access application、`APP_ORIGIN`、R2 CORS の整合性を更新します。

## 6. R2 CORS

Browser は presigned URL に対して次を送ります。

- `PUT`（upload）: `Content-Type` と `If-None-Match` header 付き（[D-013](decisions.md)）
- `GET`（`<img>` による表示、original の取得）

```json
[
  {
    "AllowedOrigins": ["https://photos.example.com"],
    "AllowedMethods": ["GET", "PUT"],
    "AllowedHeaders": ["content-type", "if-none-match"],
    "MaxAgeSeconds": 600
  }
]
```

```bash
pnpm wrangler r2 bucket cors set edgephotos-remote-test --file cors.json
```

`*` は使いません。

## 7. Setup verification

アプリを利用可能と判定する前に、少なくとも次を確認します。

- `curl https://photos.example.com/api/v1/me`（Access を通さない request）が Access のログイン画面、または Worker の `401` になる
- owner でログインして `/settings`（ライブラリ画面）を開き、`Migration` に最新の migration 名が表示される
- 写真を 1 枚 upload して timeline に表示される（R2 credential と CORS の確認）
- 共有リンクを作成し、private window で表示でき、revoke 後は表示できない

設定不足時に写真機能を匿名公開する fallback はありません。設定が欠けていれば `503 SERVER_MISCONFIGURED` です。

## 8. Update

migration は forward-only とします。

更新前に少なくとも次を確認します。

- release notes
- migration の有無
- metadata backup（`pnpm backup export`）
- breaking API / config change

Worker code rollback と D1 rollback は同じ操作ではありません。schema が進んだ後に旧 Worker へ戻すだけで復旧できるとは扱いません。

自動 upstream 更新は v1 の要件にしません。

## 9. Export / Backup

EdgePhotos が唯一のバックアップであるとは説明しません。

- `GET /api/v1/export`（ライブラリ画面の「manifest をダウンロード」）: asset metadata、album / album_assets、object manifest、期待 SHA-256
- `pnpm backup export <dir>`: manifest に加え、original と derivative を presigned URL 経由で取得し、各 original の SHA-256 を検証して保存します

```bash
EDGEPHOTOS_URL=https://photos.example.com \
EDGEPHOTOS_ACCESS_TOKEN="$(cloudflared access token -app=https://photos.example.com)" \
pnpm backup export ./edgephotos-backup
```

含めないもの: R2 credential、JWT、share secret、presigned URL。Access token は API request の header にだけ使い、R2 へは送らず、保存もしません。

owner 以外の identity（service token 等）では API を利用できないため、CLI も owner の Access token を使います。

## 10. Restore

外部公開前に、別の空環境へ restore できることを実測します。

```bash
EDGEPHOTOS_URL=https://restore-test.example.com \
EDGEPHOTOS_ACCESS_TOKEN="$(cloudflared access token -app=https://restore-test.example.com)" \
pnpm backup restore ./edgephotos-backup     # restore 後に verify も実行する
pnpm backup verify ./edgephotos-backup      # 任意の時点で再検証
```

restore は通常の upload API で再登録します（[D-015](decisions.md)）。対象 library が空でなければ拒否します。

verify が確認する項目:

- asset count
- original SHA-256（R2 から再取得して計算）
- album membership（original SHA-256 基準）
- taken_at・favorite・trash 状態・filename・size 等の主要 metadata

restore した環境では過去の share を再有効化しません（share は export に含めません）。asset ID と `createdAt` は変わります。

restore が途中で失敗した場合は、空の環境を作り直して再実行してください（再開機能は未実装）。

## 11. Uninstall

アプリ削除とデータ削除を連動させません。

推奨手順:

```text
1. export / backup
2. restore 可能性を確認
3. share を revoke
4. Worker / Access 設定を削除
5. 不要なら D1 を削除
6. R2 は写真を本当に消したい場合だけ削除
```

Worker を削除しただけで R2 bucket を自動削除しません。

## 12. Observability

中央 telemetry server は置きません。

利用者自身の Cloudflare Dashboard（Workers Logs）と、アプリ内の非機密 diagnostics（`GET /api/v1/diagnostics`、ライブラリ画面）を使います。

- asset / trash / album 件数
- 未完了 upload（`pending`）件数
- 削除処理中（`purging`）件数
- 最終 export 日時
- 適用済み migration

Worker のエラーログは request ID・route・例外名だけを出し、header・token・URL・body を出しません。

未完了 upload の R2 object は自動削除しません（Cron を置かない方針）。件数は diagnostics で確認できます。
