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

実装上の規則:

- `Cf-Access-Jwt-Assertion` header だけを検証対象にします（Cookie は読みません）。
- RS256 署名・issuer（`https://{ACCESS_TEAM_DOMAIN}`）・audience（`ACCESS_AUD`）・`exp` を検証します。
- `email` が `OWNER_EMAIL` と一致する principal だけを owner とします（大文字小文字は区別しません）。email を持たない service token は owner になりません。
- `OWNER_EMAIL` / `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` / `APP_ORIGIN` / R2 署名設定のいずれかが欠けていれば、token が正しくても `503 SERVER_MISCONFIGURED` を返し、データを返しません。

## 4. Public share

公開面は `/share/*` だけです。

```text
/share/{shareId}#{secret}
```

secret は 32 random bytes の CSPRNG を base64url 表現したものを基準とします。D1 へは hash のみ保存します。

secret と share ID が不一致・期限切れ・revoke 済み・album 削除済みのいずれでも、一律に `404 SHARE_UNAVAILABLE` を返します。secret hash の比較は定数時間で行います。

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
- Browser の R2 CORS は `APP_ORIGIN` に限定する（derivative の作り直しは original を `fetch()` で読むため、`GET` も必要。operations.md §6）。
- Access Cookie / JWT を R2 へ送らない。

| 操作 | TTL | 署名に含めるもの | 保証 |
| --- | --- | --- | --- |
| upload PUT | 600 秒 | `Content-Type`、`If-None-Match: *`、original は `x-amz-checksum-sha256` | 期限内に URL を再利用しても、保存済み object を上書きできない。original の body が申告 SHA-256 と違えば R2 が拒否する |
| owner GET | 600 秒 | — | — |
| repair PUT | 300 秒 | `Content-Type: image/jpeg`、`If-None-Match: *` | derivative key に限る。original の key は署名しない。空の key しか埋められないので、妥当な derivative を上書きできない（[D-026](decisions.md)） |
| share GET | 最大 300 秒 | — | share の残り期限を超えて発行しない |

finalize は、R2 が記録した SHA-256 と申告値の一致を確認するまで asset を `ready` にしません（[D-018](decisions.md)）。したがって `assets.sha256` は、R2 が検証した original の SHA-256 です。

例外として、D-018 より前に `ready` になった asset の `sha256` は client の申告値のままです。`pnpm backup verify` で照合するまで、この保証はありません。

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

private write API は GET で状態変更しません。例外は `GET /api/v1/export/assets` の最後のページで、最終 export 日時（`settings.last_export_at`）だけを記録します。写真・album・share には触れません。Origin は明示した `APP_ORIGIN` と比較し、受信 Host をそのまま信用しません。

- `Origin` がある書き込み request は、`APP_ORIGIN` と完全一致しなければ `403 ORIGIN_NOT_ALLOWED` とします。
- `Origin` がなく `Sec-Fetch-Site` が `same-origin` / `none` 以外の場合も拒否します。
- どちらの header もない request（Native client、CLI）は Access assertion の検証だけで判定します。

共有ページの CSP は `default-src 'self'` を基準にし、`img-src` だけ R2 の S3 endpoint を追加で許可します。

## 9. Logging

ログへ残してよいもの:

- route template
- request ID
- status
- 処理時間
- 件数
- 非機密の内部エラーコード
- `503 SERVER_MISCONFIGURED` の原因になった設定の**名前**（値は出さない）

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

D1 に参照がない R2 object を即座に「ゴミ」と判定しません。D1 restore によって索引だけ過去状態になっている可能性があるためです。storage audit はこれを `unreferenced_objects` として報告するだけで、削除しません。

storage cleanup（[D-023](decisions.md)）が削除するのは、`uploads` 行が指す key のうち、asset にならずに終わった upload のものだけです。key は server が `uploads.asset_id` から作り、client や R2 の list から受け取った文字列を削除に使いません。同じ ID の `assets` 行がある場合は削除しません。cleanup は owner の API で、Access と Origin の検査は他の書き込みと同じです。

完全削除は、asset が trash 内にあることを D1 の条件付き更新で確かめてから始めます。

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
- 申告 SHA-256 と一致しない original を保存しない・`ready` にしない。
- D1 障害時に upload を成功扱いしない。
- 完全削除が途中で止まった asset を、同じ写真の再 upload で「重複」と扱わない（reserve で登録済みと報告しない、finalize で新しい object を消さない）。
- 完全削除と同時に trash から復元された写真を削除しない。
- finalize の UNIQUE 競合の処理が、自分の作った asset の object を重複として消さない。
- storage cleanup が、写真・止まった削除・どの行も指さない object・進行中の upload の object を消さない。cleanup が片付けた upload から、後の finalize で asset が作られない。
- storage audit が何も書き込まない。
- derivative の作り直しが original を削除・変更しない。作り直しの前後で original の SHA-256、asset ID、album membership、favorite、trash、`createdAt` / `takenAt` が変わらない（[D-026](decisions.md)）。
- 作り直しの対象 object key を client が指定できない（request は asset ID だけ）。
- 作り直した derivative も、EXIF / XMP / IPTC segment を含むものは受け付けない（upload と同じ検査）。
- original が壊れている写真へ作り直しの URL を発行しない。
- 検査に通らない derivative を残さない（削除して `missing_derivative` へ戻す）。

上記は `tests/integration/*.test.ts` と `tests/e2e/vertical.test.ts` で自動化しています。ただし「preview / thumbnail から GPS が除去される」は二段構えです。canvas による再エンコードは Chromium と WebKit で確認しています。WebKit の encoder が付ける APP1 / APP13（撮影 metadata は含まない）は、Client が PUT 前に取り除きます。自動テストの対象は、その除去処理と Worker の finalize 検査（EXIF / XMP / IPTC segment を含む derivative の拒否）です。server 側の保証は変わりません（[D-020](decisions.md)）。

## 12. ローカル開発用の模擬機構

`vite dev` の間だけ、Access assertion の付与と local blob URL を dev server で模擬します（[D-016](decisions.md)）。本番 build には含まれません。`vite preview`（production build）では設定がない限り `503` で fail-closed になることを確認しています。
