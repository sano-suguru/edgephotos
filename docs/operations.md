# 運用・デプロイ・復元

この文書は、EdgePhotos v1 で実現するセットアップ、更新、backup / restore、uninstall の運用契約を定義します。

現在は実装前のため、以下は **v1 で実現する目標フロー** です。実装後は、実際に検証済みの手順へ更新します。

## 1. セットアップ目標

安全性を下げて完全ワンクリックを目指すのではなく、利用者が自分の Cloudflare account に必要な設定を明示的に確認できる構成にします。

目標フロー:

```text
1. Deploy to Cloudflare
2. Configure Cloudflare Access
3. Configure R2 signing credentials and CORS
4. Open EdgePhotos and verify setup
```

## 2. Deploy 側で自動化するもの

可能な範囲で deployment configuration に含めます。

- Worker
- Static Assets
- D1
- R2
- bindings
- D1 migrations

resource ID の転記や SQL の手実行を利用者へ要求しない構成を目指します。

## 3. 利用者が明示設定するもの

初期想定:

```text
OWNER_EMAIL
APP_ORIGIN
ACCESS_TEAM_DOMAIN
ACCESS_AUD
```

Secrets:

```text
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
```

R2 credential は対象 bucket の presigned operation に必要な最小権限へ限定します。

Cloudflare account 全体を管理できる token を EdgePhotos UI へ入力させません。

## 4. APP_ORIGIN

`APP_ORIGIN` は明示設定します。

受信した `Host` header から正規 origin を自己決定しません。

Custom domain は v1 の必須条件ではありません。custom domain を追加した場合は Access application、`APP_ORIGIN`、R2 CORS の整合性を更新します。

## 5. R2 CORS

Browser から presigned URL を利用するため、R2 bucket に CORS が必要です。

- AllowedOrigins は `APP_ORIGIN` に限定する
- 必要な method のみ許可する
- 必要な request header のみ許可する
- `*` を安易に使わない

具体的な設定例は、実装時に presigned signature が使用する header と合わせて確定します。

## 6. Setup verification

アプリを利用可能と判定する前に、少なくとも次を確認します。

- D1 binding が存在する
- R2 binding が存在する
- expected migration version になっている
- owner / Access 設定が存在する
- R2 signing credential が設定されている
- private API が非認証で拒否される

設定不足時に写真機能を匿名公開する fallback を作りません。

## 7. Update

migration は forward-only とします。

更新前に少なくとも次を確認します。

- release notes
- migration の有無
- metadata backup
- breaking API / config change

Worker code rollback と D1 rollback は同じ操作ではありません。schema が進んだ後に旧 Worker へ戻すだけで復旧できるとは扱いません。

自動 upstream 更新は v1 の要件にしません。

## 8. Export / Backup

EdgePhotos が唯一のバックアップであるとは説明しません。

portable export は最低限次を含めます。

- library metadata
- asset metadata
- album / album_assets
- original object manifest
- expected hashes

含めないもの:

- R2 credential
- JWT
- share secret
- presigned URL

original 自体を R2 から別媒体へバックアップできる手段を用意します。

## 9. Restore

外部公開前に、別の空環境へ restore できることを実測します。

確認項目:

- asset count
- original SHA-256
- album membership
- taken_at 等の主要 metadata

restore した環境では過去の share を自動的に再有効化しません。

## 10. Uninstall

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

## 11. Observability

中央 telemetry server は置きません。

最初は利用者自身の Cloudflare Dashboard と、アプリ内の非機密 diagnostics を利用します。

候補:

- upload failure count
- incomplete uploads
- D1 error count
- R2 usage
- last successful export / restore verification date

診断 export に写真内容や secret を含めません。

## 参考資料

- Deploy to Cloudflare: https://developers.cloudflare.com/workers/platform/deploy-buttons/
- Vite Plugin: https://developers.cloudflare.com/workers/vite-plugin/
- R2 CORS: https://developers.cloudflare.com/r2/buckets/cors/
- R2 presigned URLs: https://developers.cloudflare.com/r2/api/s3/presigned-urls/
