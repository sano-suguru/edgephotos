# セキュリティ

## 1. Security Contract

EdgePhotos は写真と metadata を扱うため、MVP でも以下を妥協しません。

- private R2 を維持する。
- private API は fail-closed とする。
- Access を通過しただけでは owner とみなさない。
- share は明示した album の derivative だけを公開する。
- original を share しない。
- share secret、JWT、presigned URL、R2 credential をログへ出さない。
- D1 / R2 の片側障害を成功扱いしない。

## 2. 保護対象

- original
- thumbnail / preview
- 撮影日時・位置情報等の metadata
- album 関係
- owner identity
- share secret
- R2 signing credential
- Access configuration

Cloudflare アカウントの完全侵害、利用端末の完全侵害、Cloudflare からも内容を隠す E2EE は v1 の保証範囲外です。

## 3. Private API

Private API は二段階で認証・認可します。

1. Cloudflare Access が入口を保護する。
2. Worker が Access assertion を検証し、owner identity と照合する。

JWT は存在するだけで信用しません。署名、issuer、audience、期限を固定設定に対して検証します。

認証設定、JWKS 取得、issuer / audience が不正な場合は拒否します。

## 4. Public share

公開面は `/share/*` だけです。

```text
/share/{shareId}#{secret}
```

secret は 32 random bytes の CSPRNG を base64url 表現したものを基準とします。D1 へは hash のみ保存します。

share API は object key を client から受け取りません。`assetId + variant` を受け取り、server 側で R2 key を解決します。

許可 variant:

- thumbnail
- preview

禁止:

- original
- 他 album の asset
- trash / deleted asset
- 任意 object key

## 5. Share revoke の意味

revoke 後は新しい画像 URL を発行しません。

ただし、すでに発行済みの presigned URL、取得済みファイル、browser cache、screenshot を回収できるとは説明しません。

共有失効は「以後の新規アクセスを止める」機能であり DRM ではありません。

## 6. Presigned URL

Presigned URL は bearer capability として扱います。

- 操作を PUT または GET に限定する。
- object key を限定する。
- 有効期限を短くする。
- Browser の R2 CORS は `APP_ORIGIN` に限定する。
- Access Cookie / JWT を R2 へ送らない。

share GET は最大 300 秒を初期上限とし、share 自体の残り期限を超えて発行しません。

upload PUT は 600 秒を初期上限とします。

## 7. Metadata leak prevention

original には GPS を含む可能性があります。

share へ返す metadata は allowlist 方式とし、次を返しません。

- original EXIF JSON
- GPS
- original filename
- checksum
- R2 object key
- owner information

thumbnail / preview は metadata をコピーせず生成します。

## 8. HTTP / Browser

共有ページと share API では以下を基本とします。

```http
Cache-Control: private, no-store
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
X-Robots-Tag: noindex, nofollow, noarchive
```

CSP は `self` を基準にし、third-party analytics、外部 font、不要な script を share page へ追加しません。

private write API は GET で状態変更しません。Origin は明示した `APP_ORIGIN` と比較し、受信 Host をそのまま信用しません。

## 9. Logging

ログへ残してよいもの:

- route template
- request ID
- status
- 処理時間
- 件数
- 非機密の内部エラーコード

残してはいけないもの:

- Authorization header
- Cookie
- JWT
- share secret
- presigned URL 全文
- R2 credential
- EXIF 全文
- original filename を含む機密情報

例外オブジェクトの自動 dump や debug log も対象です。

## 10. 削除

通常の削除はまず論理削除 / trash とし、すぐに original を消しません。

物理削除は再実行可能な処理にし、途中失敗から再開できるようにします。

D1 に参照がない R2 object を即座に「ゴミ」と判定しません。D1 restore によって索引だけ過去状態になっている可能性があるためです。

## 11. 必須回帰テスト

以下は UI テストより優先します。

- 未認証 private API が拒否される。
- Access user でも非 owner は拒否される。
- Access 設定異常時に private data を返さない。
- share secret 不正 / expired / revoked を拒否する。
- 別 album の asset を share から取得できない。
- share から original を取得できない。
- preview / thumbnail から GPS が除去される。
- upload finalize 再送で重複 asset が生じない。
- D1 障害時に upload を成功扱いしない。
