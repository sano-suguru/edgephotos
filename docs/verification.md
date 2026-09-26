# 検証記録

実環境と Browser で確認した結果と、まだ確認していない項目を書きます。

確認済みの項目には、環境・日付・使ったデータ・結果を書きます。再現と判断に必要な範囲に限ります。

同じ対象を確認し直したときは、既存の記述を最新の結果で更新します。追記するのは、新しい対象を確認したときと、経緯を残す必要があるときだけです。

運用の手順は [operations.md](operations.md)、性能と memory の数値は [benchmarks.md](benchmarks.md)、判断の理由は [decisions.md](decisions.md) にあります。

## 現在の状況

- 最終確認: 2026-09-25
- 確認済みの環境: local（Miniflare / `vite dev` / `vite preview`）、`remote-test`、production（[初回 bring-up](#production-の作成と初回-deploy2026-09-24): 作成・deploy・diagnose・1 人目の member の upload、login 方法の One-time PIN への変更と 2 人の login。[家族の写真を入れる前の確認](#家族の写真を入れる前の-production-確認2026-09-25): update の実走、edge の経路、desktop の Browser での CSP、Workers Logs、backup と restore drill。derivative の作り直しは remote-test で往復）
- 未確認: iPhone / Android 実機での取り込み、private app の CSP の実機での確認、2 人の household での日常の操作（[未検証](#未検証)）。Access の independent MFA は production で有効にしていない（[D-038](decisions.md)）

各項目に日付がある場合は、その日付が優先します。

## local

migration 適用、fail-closed、upload → timeline → album → share → revoke、export / restore / verify を確認済み。

## remote-test（2026-09-16〜17）

### 環境と設定

- D1・R2 の作成、remote D1 migration、`CLOUDFLARE_ENV=remote-test` での build と deploy を確認済み。
- 未設定の Worker が private / share API を `503` で拒否すること、共有ページの header / CSP、`/share/assets/*` の配信も確認済み。
- `wrangler d1 create` の後、`wrangler.jsonc` に `database_id` を書かなくても deploy できた。wrangler が `database_name` で既存 D1 を解決する（wrangler 4.131 で確認）。
- Access 境界: private path（`/`、`/api/v1/*`）が Access login へ 302 した。`/share`・`/share/{shareId}`・`/share/api/v1/*`・`/share/assets/*` は Access を通過して Worker に到達した。
- owner 以外の identity を Worker が `403` にする経路は、remote-test では実測できない。Access policy が owner のみ Allow である限り、Worker まで到達しないため。この検査は多層防御であり、回帰は unit test 側で担保する。
- preview URL: 無効化前は、preview URL 上の private API が Access のリダイレクトを受けなかった。Worker 自身の JWT 検証だけが `401 UNAUTHENTICATED` で拒否していた。漏洩はなかった。無効化後は preview URL が `404` になることを確認済み（無効にする理由は運用の [Cloudflare Access](operations.md#4-cloudflare-access)）。
- secret 運用: 7 件を Worker secret 化した。`secrets.required` が未充足のとき、deploy が不足名を挙げて失敗することを確認。充足後は fail-closed が解け、share API が `503` から `404 SHARE_UNAVAILABLE` になった。
- R2 CORS: bucket 限定の rule を適用し、読み戻しを確認済み。`x-amz-checksum-sha256` を AllowedHeaders に加えた rule も適用・読み戻し済み（[D-018](decisions.md)）。

### upload と checksum

original の checksum を remote-test の Browser から確認した（2026-09-16。canvas で生成した合成 JPEG。[D-018](decisions.md)）。

- reserve が返す original の PUT header に `x-amz-checksum-sha256` が入る。
- 同じ size で 1 byte だけ違う body の PUT は、R2 が `400 BadDigest` で拒否した。その時点の finalize は `409 UPLOAD_OBJECT_MISSING`（`original`）。
- 同じ URL へ正しい bytes を PUT し直すと `200`、finalize は `200 created`。
- S3 API で PUT した object の `checksums.sha256` を、binding の `head()` から読めた。
- owner 用 GET で読み戻した original の SHA-256 は `assets.sha256` と一致した。
- 確認に使った asset は trash へ移動済み。

upload 経路:

- owner が Access login を通したうえで、private API の成功応答と `reserve -> PUT -> finalize` が remote-test で通った。
- PUT の宛先が `*.r2.cloudflarestorage.com` であることを DevTools で確認した。Worker は本体を中継していない。
- これにより、remote-test に設定した `ACCESS_AUD` と `ACCESS_TEAM_DOMAIN` で owner の JWT 検証が通ることも確認した。

実 R2 の `412`（2026-09-17。Browser の `fetch()` から CORS 越し。canvas で作った合成 JPEG）:

- 同じ presigned PUT URL へ 2 回目の PUT を送ると、original・thumbnail とも `412` が返った。`res.status` として読め、network error にはならない。
- そのあとの finalize は `200 created`。再試行で `412` を受けた upload が、そのまま ready になれることを確認した。
- 確認に使った asset は trash へ移動済み。

duplicate handling と完全削除: 同一 original の再 upload が `409 DUPLICATE_ASSET` になること、完全削除後は同じ original を再登録できることを確認済み。

### share と境界

- share 経路: album 作成 → asset 追加 → share 発行 → 正しい secret で `200` → revoke → 同じ secret で `404` までを確認済み。
- secret 不正・secret 無しはいずれも `404`。`url` は `/share/{id}#{secret}` の形。
- share から `original` を要求すると `400`。variant は `thumbnail` / `preview` のみ。
- derivative は `*.r2.cloudflarestorage.com` から直接取得した。
- CSRF 境界: 他 origin からの `POST /api/v1/albums` が `403 ORIGIN_NOT_ALLOWED`。
- presigned URL の失効: share の derivative URL が、発行 300 秒後に R2 で `403 ExpiredRequest` になることを確認済み。
- revoke 済み share の既発行 URL が残り TTL の間だけ有効なのは、契約どおり（[共有失効（revoke）の意味](security.md#5-共有失効revokeの意味)）。

### backup / restore

- backup: remote-test に対する `pnpm backup export` と `verify` が通った。original の SHA-256 照合も一致（`ok: true`）。
- restore（2026-09-16 の drill）: 空の `edgephotos-restore-test` へ `pnpm backup restore` を実行し、`ok: true` を確認した。D1 / R2 / Access / CORS / secret は別に用意した。
- restore 先から export し直して manifest を突き合わせた。asset 数・original の SHA-256・album 構成と membership が一致した。
- 主要 metadata（size / content type / filename / width / height / takenAt / isFavorite）も一致した。
- 変わるのは `id` と `createdAt` だけで、[D-015](decisions.md) のとおり。`createdAt` はこの drill の後、[D-024](decisions.md) で保たれるようになった。
- 空でない library への restore が拒否されることも確認済み。
- 20 件規模の restore: restore-test を空にしてから 20 asset・1 album を restore した。restore 先の export と突き合わせ、asset 数・SHA-256 集合・album membership・metadata 7 項目が一致した。original 20 件の再 hash もズレなし。
- `edgephotos-restore-test` は drill 用の一時環境で、検証後に Worker・D1・R2 bucket・Access application・R2 API token をすべて削除した。

### 画像形式と original

画像形式と orientation: 合成 19 枚を upload した。EXIF orientation 1〜8、GPS タグ付き、JPEG / PNG / WebP、160×120 から 6000×4000、1:4 と 40:9 の比率を含む。

- orientation 8 種はすべて同じ向き・同じ寸法として登録された。Client が EXIF を適用している。
- derivative は全件 EXIF・GPS を持たなかった。thumbnail 512 / preview 2048 の上限を守り、上限より小さい original を拡大しない。

original の byte 保持:

- export した original を再 hash し、ローカル原本の SHA-256 と全件一致した。
- trash へ移動して復元した asset も SHA-256 が変わらなかった。

実機由来の画像: 共有経由で保存し直した iPhone の JPEG を 1 枚 upload した。`DateTimeOriginal` も GPS も持たない最小限の EXIF だったが、`takenAt` が `null` になるだけだった。upload・derivative 生成・SHA-256 保持はいずれも正常。

## Browser での取り込み（2026-09-17）

local の `vite dev`、Playwright の Chromium 151 と WebKit 26.5、macOS。

使った画像は 2 種類。

- 公開されている実機サンプル: [metadata-extractor-images](https://github.com/drewnoakes/metadata-extractor-images) と [exif-samples](https://github.com/ianare/exif-samples)。iPhone 4S〜6 Plus、Pixel 2、Galaxy S4〜S8 / Note 8、OnePlus 8、LG G3、Xperia Z3、Moto G、Oppo R7 Plus、Nokia 8.3 ほかを含む
- Pillow で作った合成 fixture

どちらも repository には入れていない。script は scratch 環境で一度きり実行し、commit していない（[テスト用 fixture](development.md#9-テスト用-fixture)）。

metadata:

- EXIF orientation 1〜8（実機の縦位置 orientation 6 を含む）は、両 engine とも thumbnail の向きが一致した。
- 次のものはいずれも upload が成功した: MakerNote（最大約 60KB）、`OffsetTimeOriginal` あり・なし、空白や範囲外の日付、orientation 0 / 9、IFD offset の破損
- `CreateDate` が偽の値（`2002:12:08`）で `DateTimeOriginal` が正しい機種も、upload が成功した
- 日付が読めない場合だけ `takenAt` が `null` になる。
- 200 件を upload し、width / height / takenAt を Pillow で求めた期待値と照合した。両 engine とも不一致 0 件。
- iPhone の HEIC を macOS の `sips` で JPEG に変換すると、`DateTimeOriginal`・`OffsetTimeOriginal`・MakerNote が残り、`-04:00` の offset 付きで取り込めた。**iOS の変換も ImageIO によると推定しているが、実機では未確認。**

拒否されるもの: 空ファイル、画像でない中身、APP1 の長さが壊れた JPEG。途中で切れた JPEG は engine で分かれ、Chromium では decode 失敗として拒否され、WebKit では下半分が灰色のまま成功する。

見つかって直した問題（[D-020](decisions.md)）:

- WebKit の canvas JPEG に APP1 / APP13 が付き、finalize が全件 `422` にしていた（WebKit で 200 件中 200 件が失敗）。
- PUT が 1 回失敗すると、その写真全体が失敗していた（通信断、応答の喪失、`503` を route で再現）。
- 300 枚を選ぶと、97 件を残して完了表示になっていた。
- 修正後は、WebKit と Chromium で 200 件が全件成功した。失敗を注入した 3 件も再試行で成功し、応答を失った PUT は `412` を経て成功した。300 件の選択は 300 件とも登録された。

memory と前処理の並列数の数値は [benchmarks.md](benchmarks.md) の「Browser の取り込み memory」にあります。

Browser の制約で試せなかったこと: WebKit では Playwright で横取りした PUT の Blob 本文が失われる。そのため再試行の再現は Chromium だけで行った（再試行のコードは engine に依存しない）。

## 継続利用のための修正（2026-09-17）

対象は、完全削除が止まった写真の再 upload、止まった削除の再開、期限切れ upload の件数、取り込みの並列数、100MB 超の事前拒否、`APP_ORIGIN` の診断。

### local

Server 側は workerd の自動テスト、並列数は unit test で確認した。

ライブラリ画面の表示と「削除を再開」、100MB 超の拒否は、Playwright の Chromium で一度だけ確認した（spec は commit していない）。

`worker: APP_ORIGIN` は local の `vite dev` に対して CLI を実行し、`localhost` で PASS、`127.0.0.1` で FAIL になることを確認した。

### remote-test

同日に remote-test へ deploy し、owner token 付きの Node script と Browser で確認した。写真は marker だけの合成 JPEG で、Worker は decode しない。

`pnpm diagnose` は FAIL なし。`worker: APP_ORIGIN` が PASS、`library: interrupted uploads` が WARN（以前の検証で残った期限切れ 2 件。600 秒待つ新しい中断は作っていない）。

その前の構成（`worker: APP_ORIGIN` と `library: *` を足す前）でも、owner token ありで 15 項目すべて PASS だった。`EDGEPHOTOS_URL` を別の origin にすると `r2: CORS for upload`（現在の `r2: CORS`）が FAIL になることも確認した。

止まった削除は、trash 済みのテスト asset を D1 で直接 `purging` にして作った。R2 の削除失敗は remote では起こせないためである。

```sql
UPDATE assets SET status='purging' WHERE id=<テスト asset> AND trashed_at IS NOT NULL
```

確認できたこと:

- `library: unfinished deletes` の WARN、ライブラリ画面の表示、「削除を再開」で削除処理中が 0 になること
- 止まった削除と同じ写真の reserve が `409` ではなく `201` を返し、古い asset の R2 object と D1 row が消えること。続く finalize は `200 created`
- 削除前に reserve・PUT 済みだった upload の finalize が `200 created` を返し、その original を owner 用 URL から読み戻せること（新しい object を重複として消さない）
- 誤った `Origin` の album 作成が `403 ORIGIN_NOT_ALLOWED`、正しい `Origin` では `400 VALIDATION_FAILED` になり、album 数が変わらないこと

実 D1 での並行実行（各 3 回）:

- 同じ `purging` asset に `DELETE` 2 本と同じ写真の reserve を同時に送ると、`DELETE` は 204/204 または 204/404（`ASSET_NOT_FOUND`）、reserve はすべて `201` だった。
- 同じ写真の pending upload 2 件を、`purging` の asset の `DELETE` と同時に finalize すると、どの回も片方が `created`、片方が同じ asset への `duplicate` になった。再送しても同じ結果。
- UNIQUE 競合の fallback を通ったかどうかは外から区別できない。
- **「競合の勝者が `purging`」の分岐は再現していない（コードの確認のみ）。**

この検証で見つけて直したもの:

- 上の 204/404 のように別の request が先に削除を終えると、「削除を再開」はその 404 で止まっていた。404 の ID は飛ばして残りを続けるよう修正した（unit test で確認）。**この修正は remote-test に deploy していない。**

後始末: テスト asset はすべて完全削除し、件数は検証前（写真 21、ゴミ箱 2、削除処理中 0、未完了 upload 2、album 1）に戻した。D1 に今回の upload 行は残っていない。

## 閲覧 UI の改善（2026-09-17）

local の `vite dev`（使い捨ての `EDGEPHOTOS_STATE_DIR`）に、合成 JPEG 90 枚と album 3 件を reserve → PUT → finalize で入れた。撮影日時は約 4 か月に分散させた。確認は Playwright script で行い、実写真は使っていない。

- desktop Chromium（1440×900）: viewer の ←/→ で前後の写真へ移動できる。60 枚目を越えると次のページを読み込んで移動を続けられる。先頭では「前の写真」が出ない。Escape で閉じると、最後に表示した写真の tile に focus が戻る
- phone（WebKit iPhone 13 相当）: 横スクロールなし、header 49px、タブは画面下に固定。viewer の「次の写真」と情報パネルの表示も確認
- phone（Chromium Pixel 7 相当、CDP の touch event）: 左右スワイプで前後に移動、タップで操作ボタンを隠す
- ゴミ箱へ移動すると viewer は次の写真を表示し、「元に戻す」で Server 上も復元される。完全削除とアルバム削除は確認 dialog を出し、キャンセルで何も変わらない
- storage への PUT を失敗させると、日本語の失敗表示と「再試行」が出て、再試行で完了する。一覧 API の 500 では Server の英語 message を出さず、再試行で表示が戻る
- album 一覧は各 album の最新の写真を cover にする（`limit=1` の album assets API。API の変更なし）
- 2 枚を続けてゴミ箱へ移動すると「元に戻す」が 2 つ並び、それぞれが対応する写真だけを復元する
- 情報パネルは写真を移動しても開いたままで、viewer を開き直すと閉じている。アップロード中の表示は完了枚数（例: 0 / 3 枚）と処理中のファイル名

Hallmark audit 後の修正（同日）は 8 件。

- 共有リンクの再発行・無効化の確認 dialog
- viewer の preview 失敗表示と再試行
- 共有ページ拡大表示の focus 管理
- Undo toast の touch target
- 長い menu のスクロール
- phone のゴミ箱の現在地表示
- 共有 dialog の入力欄 16px
- 全件完了したアップロード表示の自動消去

Playwright（Chromium / WebKit iPhone 13 相当）で確認した。各 spec は、対応する修正を戻すと失敗することも確認した。

修正中に、入れ子の Dialog で Base UI の生成 id が重複する不具合を見つけて直した。確認 dialog が外側の dialog の説明文で名前付けされていた。

**iOS Safari 実機での入力時 zoom と touch 操作は未確認。**

常設の回帰は `e2e/keyboard.spec.ts`、`e2e/mobile.spec.ts`、`e2e/viewer.spec.ts`（[テスト方針](development.md#8-テスト方針)）。**iPhone / Android の実機での swipe と safe area は未確認。**

## 見た目の整理（2026-09-17）

機能・情報設計・API は変えず、色・枠・影・ボタンの強弱だけを見直した。

このとき決めた規則は [design.md](design.md) に移した。

確認方法: local の `vite dev`（使い捨ての `EDGEPHOTOS_STATE_DIR`）に合成 JPEG 18 枚と album 2 件を入れた。Playwright で desktop Chromium（1440×900）と WebKit iPhone 13 相当の timeline・album・共有 dialog・確認 dialog・ライブラリ・viewer を、変更前後で撮って比べた。彩度の低い合成画像 24 枚でも timeline を撮った。

共有ページだけは `vite build` + `vite preview` で share API を mock して確認した。`vite dev` では CSP（`style-src 'self'`）が inline style を拒否し、CSS が当たらないため。

`pnpm check` と `pnpm test:e2e`（13 件）が通った。

## 画面の型の統一（2026-09-23）

機能・情報設計・API・文言は変えず、見た目の規則を [design.md](design.md) にまとめて全画面に当てた。token 外の色を stage token と `border` に置き換え、見出し・空状態・角丸・押下と処理中の状態・44px の操作を揃えた。新しく出す情報は timeline の月の枚数だけ。

確認方法: local の `pnpm dev` を Playwright（Chromium）で開き、375px で timeline・viewer と info sheet・album 一覧・album の共有 dialog・ライブラリを、1280px で timeline を撮って見た。375px では、見たどの画面にも横スクロールは無かった。320 / 414 / 768px では timeline・favorites・albums・ゴミ箱・ライブラリの `scrollWidth` を測り、どれも画面幅を超えなかった。

reduced motion: build した CSS で、dialog・menu・ボタン押下の scale が `prefers-reduced-motion: no-preference` の中にだけあることを確かめた。Browser で emulate しての確認はしていない。

`pnpm test:e2e`（54 件）が通った。途中で 1 件、phone の info sheet の位置の検査が落ちた。sheet が下から入ってくる途中の位置を測っていたので、sheet の入り方を fade だけにした。

「年月で移動」と「選択」を 1 行にした直後は、選択中に「年月で移動」が消え、`e2e/timeline.spec.ts` の「別の月を開くと選択が終わる」が落ちた。選択中は選択 bar の上に残すように直した。

最初の suite 実行で、`e2e/upload.spec.ts` の HEIC のサムネイル読み込み（mobile-webkit）が 1 回だけ 5 秒以内に読み込まれず落ちた。その後の suite 3 回と、単独で 5 回繰り返した実行では通った。原因は調べていない。

`e2e/mobile.spec.ts` の「選択 bar が上端に残る」は、単独で実行すると変更前の `main` でも落ちる。写真が 1 枚だけだと、600px スクロールできるほど page が長くならないため。suite 全体の順序では通る。

共有ページは stage token と見出しの class だけを変えた。inline style は足していないので、CSP 下の確認（`vite build` + `vite preview`）は今回はしていない。

## 長期保管の整合性（2026-09-17）

対象は、storage audit / cleanup、paged export、差分 backup と `check`、restore の `--resume`、verify の `--quick` です。加えて、完全削除と復元の競合、finalize の UNIQUE 競合、upload の再試行、元ファイルの形式判定も含みます。

### local（workerd の自動テスト）

競合 2 件は、修正前のコードで再現するテストを先に書いて失敗を確認した。

- 完全削除の開始と trash からの復元が交差すると、復元した写真が `purging` になって R2 から消えていた。
- finalize の D1 batch が commit した後に UNIQUE 違反が報告されると、自分の asset の 3 object を重複として消していた。SQLite 自体は、同じ upload の再送では id の競合を先に検出する。現在の D1 でこの経路に入る状況は確認しておらず、防御として直した。

storage audit:

- 1 つの ID の下に layout 外の key を 8,001 個置くと、その ID は `audit_incomplete` になった。`missing_derivative` と誤報せず、次の写真の点検は続く。印を付ける処理を外すとテストが失敗することも確かめた
- 10 分類のすべてを 1 つのライブラリに作り、`limit` を 1・2・3・5・200 にしても同じ結果になった
- object の無い asset と行だけの upload が、ページ境界をまたいでも漏れなかった
- audit の前後で D1 と R2 が変わらないことを確認した。ページの終わりを決める処理（asset 側・upload 側）を 1 つずつ外すとテストが失敗することも確かめた

storage cleanup:

- 転送済みの中断 upload は写真になった（元の upload 時刻と撮影日時を保持）
- 消えるのは、欠けている・行だけの upload と重複の残りだけだった
- 写真・trash・止まった削除・object の欠けた写真・どの行も指さない object・1 日以内の upload・進行中の upload は残った
- 2 回目は何もしない。R2 の障害では何も消さず `failed` に数える
- cleanup が upload を片付けた後、検査を終えていた finalize は asset を作らなかった（`410`）

backup:

- 2 回目は storage への request が 0、写真を 1 枚足すと 3 request
- 途中で切れたファイルは取り直した。同じ size で 1 bit 違うファイルは `check` だけが検出した
- original が壊れた写真があっても残りを backup し、その写真を名前で挙げた

restore:

- Access token が 3〜14 回目のどの API 呼び出しで切れても、`--resume` で最後まで進んだ。`verify`（全件 download）も `ok` になった
- 記録に無い album や backup に無い写真がある library には再開しない。終わった restore は再開しない
- restore 後の timeline の並びは元と同じだった（撮影日時の無い写真を含む）

verify: `--quick` が download 0 件で `ok` になり、original の size が変わった写真を storage audit で検出した。

paged export: 1 件ずつ・2 件ずつのページを重複なく連結できた。ページの間に写真の削除と追加があっても、manifest が知らない asset を指さなかった。

backup manifest v1（[D-025](decisions.md)）:

- export が書いた manifest はそのまま通り、未知の key を足しても通った
- 15 件以上あるときは 10 件と残件数を出した

次のものを、field の位置と理由付きで拒否した。

- 壊れた JSON、別の `format`、知らない `formatVersion`、必須 field の欠落、型違い
- 大文字や 63 桁の SHA-256、size 0 / 負数 / 上限超え、扱えない content type
- 空や 256 文字の filename、0 pixel、空や前後に空白のある album title
- ISO 8601 でない `takenAt`、instant でない `createdAt` / `trashedAt` / `exportedAt`
- 実在しない日時（`2024-99-99…`、3 月 1 日へ繰り上がる `2024-02-30`）
- asset ID の重複、1 つの original に 2 つの asset、album ID の重複、album 内の重複、存在しない asset への membership も拒否した

restore の入口: 壊れた manifest と壊れた `restore-state.json` は、対象ライブラリへ 1 度も request を送らずに拒否された（request が出たらテストが失敗する client で確認）。

### remote-test（2026-09-18）

`edgephotos-remote-test` へ deploy して実行した。合成 JPEG のみを使い、実写真は追加していない。

- migration `0002`・`0003` を remote D1 へ適用した。`pnpm diagnose --env remote-test` は FAIL なし（`worker: D1 schema` が `0003_filtered_list_indexes.sql`）
- D1 の `EXPLAIN QUERY PLAN`（REST、read-only）で、部分 index が D1 でも選ばれることを確認した
  - favorites: `SCAN a USING INDEX assets_favorites`
  - trash（cursor 付き）: `SEARCH a USING INDEX assets_trash ((sort_at,id)<(?,?))`
  - 止まった削除の一覧: `SCAN assets USING COVERING INDEX assets_purging`
- storage audit: `limit` を 1・2・3・500 に変えても、分類も件数も同じだった（25 枚・75 object）。実 R2 の `list()` の並びと `startAfter` は、ページ境界の前提どおりに動いた
- `--deep`: 直前に upload した asset は R2 が記録した SHA-256 と一致した。D-018 より前の 21 件だけが `original_checksum_unrecorded` になった。S3 API で PUT した object の checksum を binding の `head()` から読めることを、この構成でも確認した
- backup: 初回 27.9 秒（25 枚、storage GET 75 回）、変更なしの 2 回目は 0.64 秒（download 0、API 4 回）、1 枚追加後は 1 件だけ download。`pnpm backup check` は `ok: true`
- verify: 通常 7.1 秒（26 件 download）、`--quick` 6.1 秒（download 21 件 = checksum の記録が無い古い original のみ、5 件は R2 の記録で確認）
- storage cleanup: 以前の検証で残っていた期限切れ upload 2 件を dry run で確認し、`--apply` で破棄した（`discarded 2, cleared 2, failed 0`）。実行後の audit は「不整合なし」、`pnpm diagnose` の WARN も消えた

### restore drill（2026-09-18、`edgephotos-restore-test`）

空の D1・R2・Access application・R2 API token を新しく作り、remote-test の backup から restore した。

- restore を API 呼び出しの 13 回目と 41 回目で `401` にして 2 回中断させ、`--resume` で完走した（26 枚・1 album、最後の実行での upload は 4 枚）
- restore 先の `pnpm backup verify` は通常・`--quick` とも `ok: true`（問題 0 件）。`pnpm storage audit --deep` も「不整合なし」
- 中断した restore が残した reservation 1 件は `uploads in progress` として見えた（期限内なので cleanup の対象外）
- 終了後に Worker・D1・R2 bucket を削除した（R2 bucket は object を消してから削除）。この drill 用の R2 API token（対象は drill の bucket のみ）も削除した
- Access application 2 件は、次の drill で再利用できるため残した（[復旧 drill](operations.md#14-復旧-drill)）

作業中に分かった運用上の注意（[利用者が設定する値](operations.md#3-利用者が設定する値) に反映）:

- `wrangler secret put` で先に Worker を作ってから deploy すると、deploy 前に入れた secret は残らなかった
- 標準入力が端末でない環境では、secret の値が空のまま「Success」と表示される

### local（Browser）

`pnpm test:e2e`（Chromium・WebKit、13 件）が通った。

加えて、`vite dev` の使い捨て state に対して、Chromium で一度きりの Playwright script を実行した（commit していない）。

- album 一覧は cover の画像を読み込み、album ごとの request（`/api/v1/albums/{id}/assets`）を 1 回も送らない。空の album は icon のまま
- finalize が 3 回 `503` になった写真は「転送は終わりましたが、登録を確認できませんでした…再試行すると、転送をやり直さずに登録します」と表示された。再試行で PUT を 1 回も送らずに完了した
- 中身が PNG で名前が `.jpg` のファイルは、PNG として upload され完了した（以前は finalize が `content_type_mismatch` で毎回拒否した）
- 3 日前の中断 upload（行だけ）を D1 に入れると、ライブラリ画面の「点検する」が「途中で止まったアップロード」1 件を表示した。「中断したアップロードを整理する」で破棄され、再点検で問題なしになった

### 形式と Browser 差の確認（コードの確認のみ）

取り込み結果が Browser で変わりうる点:

- derivative の画素（縮小の実装と JPEG encoder の違い）。content identity には使わないので許容する
- WebP の orientation と、途中で切れた JPEG（[limitations.md](limitations.md) のまま）
- 撮影日時は JS の `exifr` で読むので engine に依存しない

元ファイルの形式は、今回から中身の先頭 byte で決める（finalize と同じ関数）。Browser が拡張子から推測する `type` の違いに左右されない。

## derivative の作り直し（2026-09-18）

### local（workerd の自動テスト）

`tests/integration/repair.test.ts` と `tests/unit/repair.test.ts`。R2 の object を直接消して壊し、作り直して audit が正常に戻るまでを確認した（[D-026](decisions.md)）。

- thumbnail だけ・preview だけ・両方の欠損を、それぞれ `missing_derivative` として検出し、作り直したあと audit が空になること
- 作り直しの前後で、次がすべて一致すること: `assets` 行全体、`album_assets`、`uploads` 行、original の size / etag / R2 記録の SHA-256、original の byte 列から計算し直した SHA-256。favorite と album に入れた写真、trash 内の写真でも同じ
- original が無い / size 違い / 同じ size で SHA-256 違いのとき、URL を発行せず `409 REPAIR_SOURCE_UNUSABLE` になること
- 壊れた derivative を PUT した場合（EXIF あり・JPEG でない・途中で切れている・空・size 超過）、その object を削除せずに報告し、検査時点の ETag への `If-Match` で置き換えられること
- 同時実行: 2 つの repair から同じ key へ PUT すると、後から届いた方が `412` になり、先に保存された bytes が残ること。妥当な derivative が上書きされないこと
- 完全削除と重なった場合: 削除後に届いた PUT は derivative key だけを残し（original は残らない）、audit が `unreferenced_objects` として報告すること。以後の repair は `404`
- Client 側（`repairAsset`）: `status: 'ok'` だけを完了とみなすこと。PUT が成功しても、Server がまだ欠損と言う間は作り直しを繰り返すこと。回数に上限があること。original の SHA-256 が合わなければ何も PUT しないこと

古い view を持った repair が、新しい repair の結果を取り消せないことも確認した。同じ「使えない object」を見た 2 つの repair のうち一方が写真を直したあと、もう一方の target を使うと `412` になり、直った derivative が byte 単位で残る。削除してから作り直す実装に差し替えると、このテストが落ちることも確かめた。

実装上の注意: `If-Match` に raw の `etag` を渡すと、R2 は `Invalid ETag in if-match header` を投げる。引用符付きの `httpEtag` を使う。

`pnpm diagnose` の `r2: CORS` が、`AllowedMethods` に `GET` の無い rule を FAIL にすることも unit test で確認した。

### remote-test（2026-09-18、CORS の設定と preflight のみ）

作り直しは original を `<img>` ではなく `fetch()` で読むため、応答に `Access-Control-Allow-Origin` が要る（[D-026](decisions.md)）。`edgephotos-remote-test` の bucket に対して、認証なしの読み取りだけで確認した。

- `wrangler r2 bucket cors list edgephotos-remote-test` の結果は、`allowed_origins` が app origin 1 つ、`allowed_methods` が `GET, PUT`、`allowed_headers` が `content-type, if-none-match, x-amz-checksum-sha256`。運用の [R2 CORS](operations.md#6-r2-cors) の規則のままで、作り直しのための設定変更は不要だった
- 実 R2 への preflight（`OPTIONS`、app origin）: `GET` / `PUT` とも `204` で、`Access-Control-Allow-Origin` に app origin、`Access-Control-Allow-Methods` に `GET, PUT` が返った。`fetch()` が original の body を読めることの前提を実環境で確認した
- 別 origin（`https://evil.example`）からの同じ preflight は `403` で、CORS header を返さない（「`APP_ORIGIN` に限定する」。セキュリティの [presigned URL](security.md#6-presigned-url)）

**Browser から実際に壊れた写真を作り直す往復は未実施**（下の「未検証」）。

追記（2026-09-23）: 上の「作り直しのための設定変更は不要だった」は、欠けた derivative を作る経路（`If-None-Match`）についてだけ正しい。使えない derivative を置き換える経路は Browser が `If-Match` を送るため、`allowed_headers` に `if-match` が要る。この bucket の設定のままでは、その PUT は preflight で失敗する。運用の CORS 例と `pnpm diagnose` の検査に `if-match` を加えた（[D-026](decisions.md)）。2026-09-24 に `if-match` を加えて `cors set` し直した（[upload した人の記録](#upload-した人の記録2026-09-24)）。

## CI の時間制限（2026-09-21）

GitHub Actions で `Test timed out in 5000ms` が断続的に出ていました。落ちるのは `tests/integration/export-restore.test.ts` の 1 件です。

> interrupted restore > continues where it stopped, at any point, and ends identical to the backup

判断は [D-029](decisions.md) にあります。

### CI で測った値

GitHub Actions `ubuntu-latest`、`pnpm test`。run 35576409905 の 2 回の attempt は同じ commit（62e9047、ドキュメントのみ）です。

| run | tests 合計 | storage audit の 8001 key test | interrupted restore |
| --- | --- | --- | --- |
| 35576409905 attempt 1（失敗） | 77.90s | 28880ms | 7197ms（5000ms で打ち切り） |
| 35579077350 | 34.93s | 15194ms | 2068ms |
| 35575268896 | 27.97s | 13275ms | 1981ms |
| 35576409905 attempt 2 | 20.39s | 8915ms | 1659ms |

同じコードで最も重い test が 8.9 秒から 28.9 秒まで 3.2 倍ぶれます。run の中では全部が同じ比率で伸びます（tests 合計 ÷ 8001 key test = 2.1〜2.7）。失敗した run は、この test だけが遅かったのではなく、run 全体が遅い側の端でした。

### 同じ原因で落ちうるもの

最遅 run（35576409905 attempt 1）で 5000ms に近かった test です。local は macOS / 8 core での `pnpm test`。

| test | local | 最遅 CI | 5000ms までの余裕 |
| --- | --- | --- | --- |
| storage audit: says an id was not fully checked | 5765ms | 28880ms | 既に `60_000` を個別指定していた |
| export/restore: continues where it stopped | 1002ms | 7197ms | 超過 |
| storage audit: classifies every inconsistency | 362ms | 3403ms | 1.5 倍 |
| export/restore: round-trips assets | 450ms | 2394ms | 2.1 倍 |
| storage audit: does not write anything | 763ms | 2102ms | 2.4 倍 |
| albums: adds and removes assets idempotently | — | 2083ms | 2.4 倍 |
| export/restore: verification detects missing assets | 138ms | 1763ms | 2.8 倍 |
| uploads: unique constraint race | — | 1718ms | 2.9 倍 |

CI と local の比は test ごとに 2.8〜12.8 倍と一定しません。

`storage.test.ts` の `beforeEach(resetStorage)` も同じ位置にあります。8001 key を作る test の直後の 1 回だけ local で 768ms かかります（他の回は 0〜5ms）。

CI では測っていません。同じ file の test で観測した CI / local 比は 5.0 倍（5765ms → 28880ms）です。これを掛けると約 3.8 秒、既定の `hookTimeout` 10 秒に対する余裕は 2.6 倍という見積もりになります。

### 失敗した test の中身

local で 12 周（okCalls 3〜14）の内訳を測りました。合計 690〜712ms で、突出した処理はありません。

- API 呼び出し 292 回: Worker 内 345ms
- storage 呼び出し 102 回: 85ms
- test 側の RS256 署名 292 回: 179ms（1 回 0.6ms。認証込みの GET 1 件が 1.0ms）
- D1 / R2 の初期化 12 回: 34ms

test file 単独では 725ms、suite 全体では 960〜1085ms です。`storage.test.ts` を外しても 989〜1133ms で変わらないので、local では重い 1 file が他を押し出しているのではありません。

### 直したあと

`vitest.config.ts` に `testTimeout` / `hookTimeout` = 120 秒を置き、`storage.test.ts` の個別指定を消しました。test の中身と assertion は変えていません。

run 35581112151 を 5 回続けて実行し、すべて緑でした。

| attempt | tests 合計 | storage audit の 8001 key test | interrupted restore |
| --- | --- | --- | --- |
| 1 | 66.54s | 25014ms | 5975ms |
| 2 | 28.94s | 13648ms | 2058ms |
| 3 | 29.73s | 13400ms | 2136ms |
| 4 | 26.64s | 12150ms | 1921ms |
| 5 | 30.33s | 14654ms | 2379ms |

attempt 1 は遅い runner に当たり、interrupted restore が 5975ms かかりました。変更前の 5000ms なら、この attempt は落ちています。最も重い test は 25014ms で、120 秒に対して 4.8 倍の余裕があります。

## HEIC / HEIF の取り込み（2026-09-22）

[D-030](decisions.md) の実装確認。fixture は合成した gradient を macOS の `sips -s format heic` で変換したもので、実在の人物・場所・GPS を含まない（`tests/fixtures/README.md`）。

### decode の可否（Playwright）

| engine | `still.heic`（64x32、EXIF Orientation 6） | `probe.heic`（2x2） |
| --- | --- | --- |
| WebKit 26.5（macOS） | 32x64 で decode（向きが反映される） | 2x2 で decode |
| WebKit（CI の Linux runner） | decode できない | decode できない |
| Chromium | `InvalidStateError` | `InvalidStateError` |

**decode できるかは engine ではなく実行環境で決まる。** 同じ Playwright WebKit でも、macOS では decode でき、CI の Linux runner ではできない。engine 名で分岐すると、この差で判断を誤る。e2e も UA ではなく実際の probe 結果で分岐する。

この差のため、CI で実際に通るのは HEIC を拒否する経路だけである。HEIC を保存して表示するところまでは macOS の手元実行でしか通っていない。

`imageOrientation` を指定しない場合と、Blob の type を空にした場合も同じ結果だった。

exifr は HEIC から `DateTimeOriginal`（`2019:07:14 09:30:05`）と Orientation を読めた。Node と、bundle した Web app の両方で確認している（e2e が `takenAt` を照合する）。`sips` の変換では GPS タグは引き継がれなかったため、HEIC の GPS 抽出そのものは確認していない。

fixture の orientation は EXIF の `Orientation` で持っている。実機の HEIC が使う `irot` / `imir` item property は、生成できる道具が手元になく未確認。

### 壊れた HEIC の decode

`still.heic` を壊した 4 種類を `createImageBitmap` に通した。

| 壊し方 | WebKit の decode | EdgePhotos の扱い |
| --- | --- | --- |
| 先頭 40 byte（`ftyp` だけ残す） | `InvalidStateError` | 拒否（構造が揃っていない） |
| `ftyp` の後をすべて 0 で埋める | `InvalidStateError` | 拒否（padding は box ではない） |
| 半分で切る | **32x64 で成功** | 拒否（`mdat` が 674 byte を宣言、残り 59 byte） |
| `mdat` の中身を 0xff で埋める | **32x64 で成功** | 受け入れる（構造は揃っている） |
| 末尾付近の 1 byte を反転 | 32x64 で成功 | 受け入れる（構造は揃っている） |

Chromium はどれも `InvalidStateError`。

途中で切れた HEIC が WebKit で decode できるのは、途中で切れた JPEG と同じ挙動（上の「Browser での取り込み」）。thumbnail が出ることは original が全部揃っている証拠にならないので、top-level box を歩いて、宣言された box の長さと受け取った byte 数が整合するかを Client と Worker の両方で確認する（[D-030](decisions.md)）。

最後の 2 行のとおり、長さが整合していれば中身が壊れていても受け入れる。この検査が言うのは長さの整合だけで、original が完全であることの証明ではない。

### exifr が返ってこなくなる HEIC

`ftyp` の後をすべて 0 で埋めた HEIC を `exifr.parse` に渡すと、Node で 20 秒待っても返らなかった。size 0 の box を歩き続けるためと思われる。Browser では tab ごと応答しなくなり、Playwright の page が落ちた。

対処は 2 つ入れた。top-level box type に印字可能な 4 文字を要求してこの形を先に拒否すること、metadata の読み取りを decode の成功後に移すことである。どちらも [D-030](decisions.md) に書いた。

### 自動テストで確認したこと

- `ftyp` の brand 表（HEIC still 4 種、`mif1`、sequence 4 種、`msf1`、`avif` / `avis`）と、宣言 size の不正・truncated・4 byte 単位でない compatible brands・上限超過の拒否
- 実 HEIC の reserve → PUT → finalize が通り、R2 に保存された bytes が fixture と byte 単位で一致し、SHA-256 も一致する
- HEIC と称して JPEG の bytes を送ると finalize が `content_type_mismatch` で拒否し、asset を作らない。12 byte に切り詰めた HEIC も同じ
- 同じ HEIC を別の household member が upload すると `DUPLICATE_ASSET` で同じ asset に収束する
- backup → restore で HEIC の original bytes と checksum が維持され、manifest が v2 で `image/heic` を持つ。`verifyLibrary` も通る
- share では derivative しか出ず、応答に `originals/`・filename・`image/heic`・SHA-256 のいずれも現れない。preview は `derivatives/v1/{id}/preview.jpg` の JPEG
- v1 manifest は今も読め、v1 で `image/heic` を名乗る manifest は `contentType` を名指しして拒否される
- e2e: WebKit は HEIC を追加し、記録された形式が `image/heic`、寸法が 32x64（EXIF Orientation 6 が反映された値）、`takenAt` が `2019-07-14T09:30:05`。timeline の thumbnail も 32x64 で、derivative 自体が正しい向きになっている。Chromium は「このブラウザでは HEIC を処理できません」と表示し、reserve へ進まない
- e2e: 半分で切った HEIC と、`ftyp` の後を padding にした HEIC は、WebKit では「ファイルが最後まで揃っていません」、Chromium では decode 不能として先に止まり、どちらでも asset にならない
- box header が finalize の 256KB window を越える original は、判定しきれないものとして `structure_unverified` で拒否される
- e2e: `File.type` が `application/octet-stream` の HEIC bytes も、sniff の結果どおり `image/heic` として取り込まれる
- 「probe は通るがそのファイルだけ decode に失敗する」経路は unit test のみ。WebKit は構造の揃った変種をすべて decode したため、e2e では再現できていない

### 観測した不安定な失敗

`upload.spec.ts` の「a clean upload summary clears itself…」が mobile-webkit で 1 度だけ落ちた（`uploadPanel` が自動で消えることを見る assertion、`e2e/upload.spec.ts:90`）。同じ file 単独・両 engine・suite 全体の 3 回の再実行では再現しなかった。原因は特定できていない。この test は HEIC の経路を通らないので、HEIC の変更が原因とは言えないが、無関係だとも確認できていない。

## 大量 upload の partial failure（2026-09-22）

数十〜数百枚を選んだときに、一部が失敗しても成功した写真が壊れず、失敗した行だけを再試行できることの確認。合成した JPEG だけを使い、実写真は使っていない。

### 合成 batch（`tests/unit/upload-batch.test.ts`、workerd）

batch の state machine を、upload protocol の代役に対して動かした。代役は server 側の test が固定している性質（SHA-256 ごとに asset は 1 つ、finalize は冪等、object を確認してから ready）を守る。

| 混ぜたもの | 結果 |
| --- | --- |
| 80 行 / 60 枚（20 枚は二重選択）、5 回に 1 回の転送失敗 | 1 回目で失敗した行が残り、成功と duplicate は確定。再試行後は失敗 0、asset は 60 |
| 100 枚をまとめて選択 | 同時に前処理した枚数の最大は 2（`createTaskLimiter(2)`、[D-020](decisions.md)）。全件 done、asset は 100 |
| 1 枚だけ転送失敗、他は成功 | 失敗 1・完了 4。asset は 4。再試行では失敗した行の file だけを前処理し直し、asset は 5 になる |
| 転送済みで finalize の応答だけ失った | 再試行は前の reservation の finalize だけを送る（prepare 0 回、reserve 0 回、PUT 0 回）。asset は 1 |
| 同上で、再試行時に file が decode できない | 完了する。server へ先に聞くため前処理に入らない。asset は 1 |
| storage が PUT を拒否し続ける | 再試行のたびに新しい reservation から始める（2 回の再試行で reserve 3 回）。拒否された reservation へ送り直し続けない |
| 到達できない network | reservation を保持したまま（2 回の試行で reserve 1 回） |
| 100MB 超・途中で切れた file・HEIC を decode できない Browser・decode 失敗 | 再試行の対象にしない。file を手放すので、ボタンからも拾われない |
| finalize が original を `incomplete_file` で拒否 | 再試行の対象にしない。asset は 0 |
| finalize が thumbnail の `size_mismatch` で拒否 | 再試行できる。再試行で done |

### Browser（Playwright、`e2e/upload.spec.ts`）

2 枚を選び、先に storage へ届いた側の object をすべて `403` で拒否した。

- 失敗 1・完了 1。完了した写真は timeline に出たままで、summary は「1 枚を追加しました、1 枚は追加できませんでした」
- 「失敗した 1 枚を再試行」を押すと、その行だけが前の reservation から続きを送って完了する
- 2 枚とも `/api/v1/assets` に 1 件ずつだけ現れる

CI の Linux runner でも同じ経路を通る（HEIC の decode 可否に依存しない）。

### 未解決: suite 全体で落ちる HEIC の test（macOS）

`upload.spec.ts` の「uploads a photo with browser-made derivatives…」が、mobile-webkit で suite 全体を通したときだけ落ちる（`e2e/upload.spec.ts:48`、HEIC の thumbnail が `naturalWidth` 0 のまま）。この test だけを実行すると通る。

この branch の変更を stash した `main` の状態でも同じように落ちたので、今回の変更が原因ではない。原因は特定していない。

CI は Linux runner の WebKit で HEIC を decode できないため、この assertion のある分岐（`if (heicDecodes)`）に入らない。CI が緑でもこの経路は通っていない。

## timeline の年月 navigation（2026-09-22）

年月の一覧・jump・前後の pagination の確認（[D-031](decisions.md)）。合成データだけを使い、実写真は使っていない。

### Worker（`tests/integration/timeline-months.test.ts`、workerd）

各 test は空の library から始める。件数が library 全体の値だからである。

| 確認したこと | 結果 |
| --- | --- |
| 複数年・複数月（2022-12 / 2024-03 / 2024-05） | 写真のある月だけが新しい順に、件数付きで並ぶ。間の空の月は行が無い |
| offset 付きの撮影時刻（`2024-05-01T08:00:00+09:00`、UTC では 2024-04-30） | 2024-05。grid の見出しと同じ月になる |
| 撮影時刻の無い写真（`createdAt` 2024-04-30T23:30Z） | 2024-04（UTC の upload 月）。並び順の fallback は変わらない |
| 指定の月へ jump | その月の最も新しい写真から page が始まる |
| 違う月の写真が同じ `sort_at` を持つ（`+09:00` と `-12:00`）。あとの月の写真の id を小さくした | 5 月を選ぶと 5 月の写真が先頭。位置を指す cursor（`MAX(sort_at) + 1`）ではここが 4 月から始まる（この test で確認） |
| 最も新しい月 | cursor は null。timeline の先頭から始まり、上の page は提示されない |
| jump した位置から上下へ全部読む | 上と下を合わせると timeline 全体と一致し、重複も欠けも無い |
| 同じ撮影時刻の写真が 3 枚 | 3 枚とも jump した page に入る。id による取りこぼしが無い |
| upload の直後 | 新しい月が現れ、既存の月の件数が増える |
| trash と restore | trash の間はその月が消え、restore で件数ごと戻る。timeline と一致する |
| household の 2 人目の member | 同じ年月構成が返る |
| 5,000 枚・25 か月 | months は 25 行。合計は 5,000。trash だけの月は出ない。月からの 1 ページは 60 件で、続きの cursor がある |
| cursor 無しの `direction=newer` | `400 VALIDATION_FAILED` |
| timeline の先頭 | `prevCursor` は null。2 ページ目からは上へ戻れて、戻ると null になる |

### Browser（Playwright、`e2e/timeline.spec.ts`、chromium と mobile-webkit）

5,000 枚・25 か月の library は test 側が答える。server の挙動は上の integration test が固定しているため、ここでは Browser 側だけを見る（[D-021](decisions.md)）。

- 月を選ぶと `?m=YYYY-MM` が URL に残り、その月の見出しから表示される。読み込む tile は library 全体ではなく数ページ
- browser の戻る / 進むで、最新の先頭とその月を往復できる。`?m=` 付きで開き直しても同じ月から始まる
- 「これより新しい写真」を押すと 1 ページ上を読む。重複は無く、library の並び順のまま連続している
- 月の見出しは scroll 中も上端に残る（desktop は header の下、phone は画面上端）
- dialog には写真のある月だけが件数付きで並ぶ。「最新の写真へ」で先頭に戻る
- 最も新しい月を選ぶと timeline の先頭が出て、「これより新しい写真」は現れない
- 撮影時刻のない写真を upload した直後、その月が dialog に出る（`upload.spec.ts`。実 library を実 API で読む唯一の経路）

**scroll 位置を保つ方法は採れなかった。** 上に page を足したあと、読んでいた写真の位置を復元しようとすると、Chromium で約 1,200px ずれた。section が `content-visibility: auto` なので、render されるまで高さは `contain-intrinsic-size` の見積もり（40rem）のままで、その section が render された時点で残りの高さの分だけ下へ動く。`scrollHeight` でも、写真を anchor にした相対位置でも同じだった。押した結果として新しい写真を見せる（先頭へ移動する）方式にした。

### 直した race

「これより新しい写真」の request 中に別の月へ移ると、その list はもう上を読んでいないのに `loadingNewer` が true のまま残り、以後 button が反応しなくなっていました。reset でこの状態を明示的に降ろします。`tests/unit/page-list.test.ts` に、stale な応答が届いたあとで同じ list から上を読める test を置きました（修正前は失敗します）。

### DOM と memory

5,000 枚を末尾まで読み込むと Chromium で 15,128 node、年月から開くと 419 node。数値と条件は [benchmarks.md](benchmarks.md) にある。thumbnail を 1x1 に差し替えた測定なので、decode 済み画像の memory は含まない。

## upload した人の記録（2026-09-24）

`0004_asset_uploaded_by` と manifest v3（[D-034](decisions.md)）を remote-test へ入れ、同じ日に確認した。対象は main の `127fb99`（#43）。

### release

運用の [更新](operations.md#8-更新release-と-migration) の「追加だけの migration」の手順で行った。

- migration 前の D1 bookmark: `0000004e-00000000-000050f0-bd90af91599b32fc7c34520842b7ce2f`
- migration: 未適用は `0004_asset_uploaded_by.sql` だけだった。`d1 migrations apply --remote` で適用に成功した
- deploy: Worker version `5e140e3e-33d1-4c7c-a73b-9f27ae549585`。前回の deploy は 2026-09-22 なので、#35 以降の main もこの deploy で入った
- 同じ日、production の Worker・D1・R2 が存在しないことを `wrangler` で確かめた（Worker は API の `10007`）。production に適用する migration はまだ無い

### diagnose

`EDGEPHOTOS_URL` と Access token を付けた `pnpm diagnose --env remote-test` の結果:

- Worker の D1 が `0004_asset_uploaded_by.sql` まで適用済みであることを含め、1 件を除いて PASS した
- 失敗は `r2: CORS — AllowedHeaders lacks: if-match` の 1 件だった。実 R2 に対しても、足りない header を名指しする message になった（[derivative の作り直し](#derivative-の作り直しremote-test) の確認で記録を求めていた項目）
- bucket の `allowed_headers` に `if-match` を加えて `cors set` し直した。origin・method・max age は変えていない
- 直した後は `r2: CORS` を含めて全項目が PASS し、「no failures」になった

### backup

新しい CLI で `pnpm backup export` と `pnpm backup check` を実行した。

- 300 枚と album 5 件を取得し、失敗は 0 件だった。`check` も `ok: true`、problems 0 件
- `manifest.json` は `formatVersion: 3` で、300 枚すべてに `uploadedBy` の key があった。値はすべて `null`。どれも `0004` より前に入った写真で、推測で埋めていないことと一致する
- restore は実行していない。空のライブラリが要るためで、round-trip は `tests/integration/export-restore.test.ts` で確認している
- backup のコピーは確認後に削除した

### smoke

利用者が Browser で PNG を 1 枚 upload した。viewer の「最初に追加した人」に自分の email が表示されることを、利用者が確認した。

同じ写真を API（`GET /api/v1/assets`）でも確かめた。最新の 1 枚（2026-09-24 03:03 UTC）の `uploadedBy` には email が入り、それより前の写真は `null` だった。

2 人目の member による upload は、実環境では確かめていない（[2 人の household での利用](#2-人の-household-での利用)）。

## 初回 deploy の secret の渡し方（2026-09-24）

production の作成前に、Worker がまだ無い状態からの初回 deploy を確かめた。remote-test は Worker が既にあるため使えない。

使い捨ての Worker `edgephotos-bootstrap-test` を使った。数行の Worker で、`secrets.required` は production と同じ 7 つ。D1 / R2 の binding は持たず、`workers_dev: false` で URL も持たない。secret の値はすべてダミー。wrangler 4.131.2。

- `--secrets-file` を付けない初回 deploy は、7 つの名前を挙げた `The following required secrets have not been set` で失敗した
- `wrangler deploy --secrets-file <.env 形式>` は初回 deploy として成功した。`wrangler secret list` に 7 つの名前が出た
- 続けて `--secrets-file` を付けずに deploy し直しても成功し、`secret list` の 7 つは残った
- 確認後に Worker を `wrangler delete` で削除し、`10007`（存在しない）を確認した

この結果を [初回の deploy で secret を渡す](operations.md#初回の-deploy-で-secret-を渡す) に反映した。

## production の作成と初回 deploy（2026-09-24）

運用の [リソース作成とデプロイ](operations.md#2-リソース作成とデプロイ) の順で、production（`wrangler.jsonc` の top-level 設定）を作った。対象は main の `f1939d1`（#46）、wrangler 4.131.2。Worker の hostname は workers.dev。

### D1・R2・build

- `pnpm check` が通った後、`wrangler d1 create edgephotos` と `wrangler r2 bucket create edgephotos` で作成した。作成前にどちらも存在しないことを確かめた
- `d1 migrations apply edgephotos --remote` で `0001`〜`0004` を順に適用した。その後の `migrations list` は `No migrations to apply!`
- `r2 bucket dev-url get` は r2.dev が無効、`r2 bucket domain list` は custom domain なし
- `CLOUDFLARE_ENV` なしの `pnpm build` が成功し、`dist/edgephotos/wrangler.json` の Worker・D1・R2 の名前はすべて `edgephotos` だった

### Access

- private（hostname のみ、Allow）と `/share`（wildcard なし、Bypass・Everyone）の 2 つの self-hosted application を、Cloudflare API で作った。destination は public、session duration は 24 時間（remote-test と同じ）
- 作成後に API で読み直し、2 つの hostname が `APP_ORIGIN` と同じ host であること、Allow policy の email が `HOUSEHOLD_EMAILS` と同じ 2 人であることを確かめた
- household に含めていない email での login 拒否は、下の「login 方法を One-time PIN にする」で確かめた

### login 方法を One-time PIN にする（2026-09-24）

account の identity provider は Cloudflare アカウントでのログインだけで、「account の member に限る」設定だった。account の member でない 2 人目は login できないため、運用の [login 方法](operations.md#login-方法) のとおりに変えた。

- Cloudflare API で One-time PIN の identity provider を作った。既存の Cloudflare の identity provider は残した
- private application を、変更前の設定に `allowed_idps`（One-time PIN だけ）と `auto_redirect_to_identity: true` を足して更新した。読み直すと、policy の email（2 人）、hostname、AUD、session duration（24 時間）は変更前と同じだった。`/share` の application は更新されていない（`updated_at` が作成時のまま）
- 認証なしの `curl` で、`/` と `/api/v1/assets` は Access の login へ `302`、`/share` は `200`、`/share/api/v1/*` は Worker の `404` だった。login 画面は identity provider の選択を挟まず、email の入力欄を返した
- 最新の Worker version の preview URL（`<version>-edgephotos...workers.dev`）は `404` だった

- 利用者（household の 1 人目）が、自分の email に届いたコードで login できた
- 2026-09-25、2 人目の member も OTP で login し、写真を upload できた。登録していない email を入れたときはコードが届かなかった。いずれも利用者の報告

### deploy と CORS

- 7 つの secret を `.env` 形式の file にまとめ、`wrangler deploy --config dist/edgephotos/wrangler.json --secrets-file <file>` の初回 deploy が成功した。`wrangler secret list` では 7 つとも `secret_text`
- file の置き場所だけ、運用の手順（repository の外）から外れた。repository 内の git が無視する path に置き、deploy の直後に削除した。commit には入っていない
- R2 CORS は、運用の [R2 CORS](operations.md#6-r2-cors) の規則を `APP_ORIGIN` の origin だけで `cors set` し、`cors list` で読み戻した。設定前の bucket に CORS 規則は無かった

### diagnose と smoke

- `EDGEPHOTOS_URL` と Access token を付けた `pnpm diagnose`（`--env` なし）は、library が空のため `r2: presigned GET` だけが SKIP で、ほかは PASS した
- 利用者（household の 1 人目）が Browser で写真を 1 枚 upload した。timeline に thumbnail、viewer に preview が表示され、「最初に追加した人」に login した email が出ることを、利用者が確認した
- D1 では、その asset が `ready`、`uploaded_by` が同じ email、upload の行が `finalized` だった。R2 には original と `derivatives/v1` の thumbnail・preview の 3 つがあった（`r2 object get` で byte 数だけを確認）
- upload 後に `pnpm diagnose` を再実行し、`r2: presigned GET` を含む全項目が PASS した（no failures）

2 人目の member の login と upload は、上の「login 方法を One-time PIN にする」で確かめた。2 人での日常の操作は、まだ確かめていない（[2 人の household での利用](#2-人の-household-での利用)）。

## Workers Logs が credential の header を伏せるか（2026-09-25）

production の Workers Logs（invocation log）を、Cloudflare の observability API（MCP）で読んだ。値そのものは読まず、header の値ごとの件数だけを集計した。

- 2026-09-19〜25 の invocation log で、`cf-access-jwt-assertion` は 35 件すべて `REDACTED`、`cookie`（Access の `CF_Authorization` を含む）は 25 件すべて `REDACTED` だった
- share API には、それまで request が無かった。存在しない share ID と偽の secret（`Bearer` と 43 文字）で `GET /share/api/v1/shares/{shareId}` を 1 回送り、`404` を確かめた。その log の `authorization` は `********` だった
- 同じ log の request URL は伏せられず、share ID を含んだまま残る。share ID は secret ではない（secret は fragment にあり、request に載らない）

Workers Logs では、この 3 つの header の値は伏せられた状態で記録され、observability API からも伏せられた値しか取得できなかった。Cloudflare の内部で値を保存していないことまでは確かめていない。`invocation_logs` は有効のままにする（[ログ](security.md#9-ログ)）。

同じ日に、残りの経路も件数だけで確かめた（Cloudflare の observability API の needle 検索。2026-09-18〜25 の 7 日分）。

- CLI（`pnpm diagnose`）の `cf-access-token` を含む invocation は 10 件。JWT の先頭（`eyJ`）を含む invocation は、どの header でも 0 件だった
- needle 検索が header の値を読むことは、`REDACTED` が 35 件見つかることで確かめた
- presigned URL を返す `/api/v1/assets` への invocation は 20 件。presigned URL の署名（`X-Amz-Signature`）を含む invocation は 0 件だった。response body は記録されていない

### 確認手順（再実行用）

家族の写真を production に入れる前、Cloudflare の Workers Logs の仕様変更を知ったとき、`observability` の設定を変えたときに行う。値は読まず、件数だけを見る。

1. 確かめたい経路に request を起こす。private app を開いて写真を 1 枚表示する（`Cf-Access-Jwt-Assertion`、Cookie、presigned URL を返す response）。`pnpm diagnose` を token 付きで実行する（`cf-access-token`）。存在しない share ID に偽の secret で `GET /share/api/v1/shares/{shareId}` を送る（`Authorization`）
2. 数分待つ。直後は、手順 1 の invocation がまだ検索に出ない。その後 Cloudflare の observability API（dashboard の Workers Logs の検索、または MCP の `query_worker_observability`）で、service を `edgephotos` に絞り、直近の期間について needle の件数（`count`）を数える。events を表示しない
3. 次の needle を数える

| needle | 合格 | 不合格 |
| --- | --- | --- |
| `cf-access-jwt-assertion`、`cf-access-token`、`authorization` | 1 件以上（手順 1 の request が記録された） | 0 件なら手順 1 からやり直す（この結果では判定できない） |
| `REDACTED` | 1 件以上（needle が header の値を読む） | 0 件なら検索方法を見直す |
| `eyJ`（大文字小文字を区別） | 0 件 | 1 件以上: JWT が生で残っている |
| `X-Amz-Signature` | 0 件 | 1 件以上: presigned URL が残っている |
| 手順 1 で使った偽の share secret | 0 件 | 1 件以上: `Authorization` が生で残っている |

不合格なら、`wrangler.jsonc` の `observability` に `"logs": { "invocation_logs": false }` を足して deploy し、同じ手順で 0 件になることを確かめる。自分で書くログ（`console.*`）は残る（[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)）。残っている log は、保存期間が過ぎるまで消えない前提で扱う。

## private app の CSP（2026-09-25）

local で確かめた後、remote-test と production に deploy した（[D-037](decisions.md)）。desktop の Browser での確認まで済んだ。実機は未確認（下の「未検証」）。

- `pnpm test:e2e`（Chromium、WebKit）の全 spec が、CSP 違反 0 件で通った。`e2e/fixtures.ts` がすべての page と guest の context で `securitypolicyviolation` を集め、1 件でもあれば失敗にする。upload の presigned PUT、thumbnail / preview の表示、original のダウンロード（presigned GET の `fetch()`）、共有ページ、Base UI の Dialog / Menu を含む
- `e2e/csp.spec.ts`: `/`、`/albums`、未知の path の HTML に CSP が付く。注入した inline `<script>`、`onerror=`、別の origin の `<img>` が拒否される。`page.evaluate()` からの `eval()` は DevTools の評価として CSP の対象外になるため、`eval()` は header に `'unsafe-eval'` が無いことで確かめた
- timeline の spec は画像を `data:` URL で返していたため、CSP に拒否された。test 側で同じ origin の URL から返すように直した。app の変更ではない
- production build（`vite build` + `vite preview`）: `/`、`/albums`、未知の path、`/share/{shareId}` に CSP が付き、`/share/assets/*` は static assets のまま（CSP なし）。`/index.html` は `/` への `307`。Chromium と WebKit で `/`、`/albums`、`/settings` を開き、CSP 違反 0 件、stylesheet が読み込まれることを確かめた（設定が無いので API は `503`）
- fresh-context の security review で、`/share/assets/` の無いファイル（Worker を通らず、Access の外）に static assets の SPA fallback が private app を CSP なしで返すことが見つかった（`vite preview` で `200`、`/` と同じ ETag）。`not_found_handling` を `"none"` にし、fallback を Worker に移した。直した後の `vite preview` では、`/share/assets/nope`・`/share/assets/`・`/share/assets/nope.html` が `404`（body なし）、`/`・`/albums`・未知の path は CSP 付きの app だった。`pnpm diagnose` の `share: asset miss` で deploy 後も確かめる。実際の edge での結果は下の deploy の項
- SPA の fallback を page の読み込みに絞った後の `vite preview`: `Sec-Fetch-Mode: navigate` の `/albums` と未知の path は CSP 付きの app、`/favicon.ico`（`no-cors`）と `/missing.js` は `404`、`/share/assets/nope` は `404` だった。`Sec-Fetch-Mode` を付けず `Accept: text/html` だけを送った request は、preview では `404` になった。preview の中継に使う Node の `fetch()` が `sec-fetch-mode: cors` を足すためで（Node の `fetch()` の送る header で確認）、Worker の判定は integration test で確かめた。production の edge で header の無い client がどうなるかは未確認
- `//api/v1/me` は `vite preview` では CSP 付きの app になった。preview の server が `//api` を host として読むためで、Hono に直接渡した `//api/...` と `/API/...` は `404` になる（`tests/integration/app-shell.test.ts`）。production の edge では Access が止めた（下の deploy の項）
- deploy（2026-09-25、PR #51 の merge 後）: remote-test は version `78807a9f`、production は version `14289e10`。migration は無い
  - `pnpm diagnose` は、両方とも token 付きで全項目 PASS だった。`share: asset miss`、`private app: CSP`、`private API`、`r2: presigned GET` まで PASS。`private app: CSP` は、`img-src` と `connect-src` の両方に自分の account の R2 endpoint があることを見る
  - 実際の edge で、`/share/assets/nope`・`/share/assets/nope.html`・`/share/assets/` は `404`（body なし）だった。Worker へは回らない
  - `//api/v1/me` は Access の login へ redirect された。この request は Worker まで届かない
  - token 付きの diagnose の後に、production の Workers Logs（2026-09-18〜25）を数えた。`eyJ` と `X-Amz-Signature` を含む invocation は 0 件だった
  - `cf-access-token` を含む invocation は 16 件で、今回の `GET /` を含む
  - diagnose の直後の検索では、今回の invocation は 1 件も出なかった。数分後に現れた
  - production の Browser で、開発者ツールの console を開いたまま写真を 1 枚 upload し、timeline・viewer・original のダウンロード・共有ページを開いた。CSP の違反は出なかった（利用者の報告。使った browser は記録していない）
- `vite dev` では Vite の module も Worker を経由する。nonce を付けたことで、共有ページの `vite dev` で CSS が当たらない問題（[見た目の整理](#見た目の整理2026-09-17)）も起きなくなった

## 家族の写真を入れる前の production 確認（2026-09-25）

家族の写真を入れる前に、main の `8218a7e` を production に deploy し直し、Browser・Workers Logs・Access・backup を確かめた。derivative の作り直しは remote-test で往復した。実機・2 人での操作は下の「未検証」に残る。

### deploy と diagnose

運用の [更新](operations.md#8-更新release-と-migration) の「migration なし」の手順（check → deploy → diagnose）を、production で初めて実走した。

- 前の version `14289e10`（#51）との差は docs だけだった。`pnpm check`（typecheck・lint・`db:check`・`cli:check`・unit / integration 496 件・build）と `pnpm test:e2e`（63 件）が通った
- `pnpm build`（`CLOUDFLARE_ENV` なし）の D1・R2 の名前は `edgephotos`。deploy 後の version は `d560e0e8`。`wrangler secret list` の 7 つは残った
- token 付きの `pnpm diagnose` は deploy の前後とも 19 項目すべて PASS（`r2: presigned GET`、`share: asset miss`、`private app: CSP` を含む）

### Static Assets の経路（実際の edge）

Access token を付けた `curl` の結果:

| request | 結果 |
| --- | --- |
| `Sec-Fetch-Mode: navigate` の `/albums`、未知の path | `200`、CSP 付きの app |
| `Sec-Fetch-Mode: no-cors` の `/missing.js`・`/missing.png`・`/missing.json`・`/favicon.ico` | `404`（body なし） |
| `/api/v1/nope` | `404`（JSON） |
| `Sec-Fetch-Mode` なし、`Accept: text/html` だけ | `200`、CSP 付きの app |
| どちらの header も無い未知の path | `404` |
| 匿名の `/share/assets/nope`・`nope.html`・`/share/assets/`・`x.js` | `404`（body なし） |

「production の edge で header の無い client がどうなるか」（上の「private app の CSP」）は、これで確かめた。

### Browser での CSP

Playwright（Chromium 153 の headless、WebKit 26.6）で production を操作した。Access token は app の host の `CF_Authorization` Cookie にだけ置いた。写真は page の canvas で描いた合成画像と、repository の合成 HEIC（`tests/fixtures/still.heic`）。

- 両方の engine で、upload（presigned PUT）→ timeline の thumbnail → viewer の preview → original のダウンロード → album の作成と共有リンクの発行 → 別 context（Access の Cookie なし）の共有ページで thumbnail と拡大表示 → revoke 後に「このリンクは無効か、期限切れです。」まで通った
- ダウンロードした original は `blob:` URL 経由で、SHA-256 が upload した bytes と一致した
- CSP 違反は、private app と共有ページのどちらでも 0 件。R2 への request の失敗も 0 件
- 確認に使った 3 枚は trash へ移し、album は削除した

### 利用者の端末での確認

利用者が production で、repository の外で作った合成画像（乱数の画素だけで、人物・位置情報を含まない）を使って確かめた。結果は利用者の報告で、下の User-Agent だけを Workers Logs で確かめた。

| ファイル | 大きさ |
| --- | --- |
| JPEG 24MP（gradient） | 1.0 MB |
| HEIC 24MP（gradient） | 0.1 MB |
| JPEG 48MP | 53.0 MB |
| HEIC 48MP | 37.7 MB |
| JPEG 23.9MP（100 MB 近辺） | 93.8 MB |

- Brave（macOS、Chromium 153）: JPEG 3 枚は upload が完了した。HEIC 2 枚は「このブラウザでは HEIC を処理できません」で、読み込む前に止まった（HEVC を decode できない browser の設計どおりの拒否。[D-030](decisions.md)）。93.8 MB の original の「保存したファイルをダウンロード」を続けて 3 回行い、すべて成功した。CSP の違反は無かった
- iPhone の Safari（利用者の報告）: login、5 枚の upload（HEIC 2 枚を含め完了）、timeline と preview、original のダウンロード（93.8 MB を続けて 3 回）、共有と revoke、Web インスペクタでの CSP 違反 0 件。いずれも問題は無かった
- 同じ時間帯の Workers Logs の User-Agent に `iPhone` を含むものは無く、Safari は `Macintosh; Intel Mac OS X 10_15_7 … Version/26.4 Safari/605.1.15` の 1 種類だった。iPhone の Safari がこの形を送るのは「デスクトップ用 Web サイトを表示」が有効なときで、User-Agent からは Mac の Safari と区別できない。アプリは User-Agent で分岐しないため、API・R2・CSP の経路は同じ。phone 幅の表示とタッチ操作は、この確認では確かめたことにならない
- HEIC 2 枚の「完了」は upload の画面の表示による。確認後に完全に削除したため、保存された形式（HEIC のままか、iOS が JPEG に変換したか）は確かめていない
- 確認後、利用者が確認用の写真と既存の 1 枚を完全に削除した（意図どおり）。その後の library は 0 枚、storage audit の問題は 0 件、R2 の object は 0 個
- D-036 の再検討条件（iPhone Safari で original のダウンロードが失敗する）は発火していない

### Workers Logs

上の [確認手順](#確認手順再実行用) を、この日の 06:40 UTC 以降（上の diagnose・Browser 操作・偽の share secret の request を含む）について再実行した。件数だけを数えた。

| needle | 件数 | 判定 |
| --- | --- | --- |
| `cf-access-jwt-assertion` | 79 | 記録あり |
| `cf-access-token` | 36 | 記録あり |
| `authorization` | 10 | 記録あり |
| `REDACTED` | 115 | needle が header の値を読む |
| `eyJ`（大文字小文字を区別） | 0 | 合格 |
| `X-Amz-Signature` | 0 | 合格 |
| 偽の share secret | 0 | 合格 |
| `CF_Authorization` | 0 | Cookie の値ごと伏せられている |

`invocation_logs` は有効のままにする。

### Access の設定

Cloudflare API で読み直した（GET のみ）。private application は 2026-09-24 10:37 UTC（One-time PIN への変更）から、`/share` の Bypass は作成時から更新されていない。

- private: Allow policy の email は 2 件で、利用者の email を含む。identity provider は One-time PIN の 1 つ、session duration 24 時間。`require`（MFA などの追加条件）は無い
- `/share`: Bypass・Everyone、path に wildcard なし
- Allow policy の email と `HOUSEHOLD_EMAILS` の一致は、secret の値を読めないため、この日は再確認していない（2026-09-24 の作成時に確認）

### derivative の作り直し（remote-test）

remote-test（version `78807a9f`、production と同じ code）で、合成の JPEG を 1 枚 upload して往復した。Browser（Chromium）の `fetch()` から実 R2 へ送り、presigned URL はすべて bucket の CORS を通った。thumbnail の削除と壊れた object の配置は `wrangler r2 object`。

- 正常な写真の repair は `ok`
- thumbnail を削除すると `incomplete`・`missing: ["thumbnail"]` で、target の条件は `if-none-match: *`。original の presigned GET を Browser が CORS 越しに読み、SHA-256 が `source.sha256`（`assets.sha256`）と upload した bytes の両方に一致した
- create-only の PUT は `200`。同じ URL への 2 回目は `412`。R2 には 1 回目の bytes が残った
- thumbnail の key に JPEG でない object を置くと `rejected: not_jpeg` で、target は `if-match`（検査した ETag）。続けて 2 回 repair を呼ぶと、両方が同じ ETag を指した
- 1 回目の target への PUT は `200`、2 回目の target（古くなった ETag）への PUT は `412`。R2 には 1 回目の bytes が残った。先の create-only の URL も `412`
- この test で PUT した thumbnail は、page の canvas の出力を metadata の除去をせずに送ったため、次の repair が `rejected: metadata_segment` と判定した（Worker の検査が効いている。アプリは `stripJpegMetadata` を通す）
- 最後に thumbnail を削除し、ライブラリ画面の「点検する」→「1 枚のサムネイルを作り直す」→ もう一度「点検する」で、作り直しのボタンが消えた。その後の repair は `ok`。CSP 違反は 0 件
- 使った写真は trash へ移した

`409 REPAIR_SOURCE_UNUSABLE` は、original を壊す必要があるため実環境では確かめていない（integration test で確認）。

### backup

production を `pnpm backup export` し、`pnpm backup check` した。

- 4 枚（member の写真 1 枚と、上の確認で upload した合成画像 3 枚）、album 0 件。download 4、失敗 0、4 秒。`check` は `ok: true`、problems 0 件
- `manifest.json` は `formatVersion: 3`。`X-Amz`・`Signature`・`eyJ`・`Bearer`・`CF_Authorization`・`cf-access`・R2 の host・`http://`・`https://`・`#` は 0 件
- asset の key は `id, sha256, originalSize, contentType, filename, width, height, takenAt, isFavorite, trashedAt, createdAt, uploadedBy, objects`。`uploadedBy`（email）と `filename` は設計どおり入る（[backup ディレクトリ](security.md#backup-ディレクトリ)）

### restore drill（`edgephotos-restore-test`）

運用の [復旧 drill](operations.md#14-復旧-drill) の手順で、上の backup を空の環境へ restore した。manifest v3 を実環境へ restore したのは、これが初めて。

- 空の D1（`0001`〜`0004` を適用）・R2 bucket（r2.dev 無効、CORS は restore-test の origin のみ）・Worker（version `a14f7b97`、production と同じ build の名前と binding だけを変えた設定）を作った。Access application は 2026-09-18 のものを再利用した
- R2 API token（Account API Token、Object Read & Write、TTL 付き）は、最初は対象の bucket が `edgephotos-remote-test` になっていた。restore の最初の PUT が `403` で止まり、restore-test の bucket への S3 の一覧・PUT が `AccessDenied` になることで分かった。利用者が対象を restore-test だけに直した後、restore-test への PUT は `200`、remote-test と production の一覧は `AccessDenied` だった
- この `403` で止まった restore を `--resume` で再開し、4 枚・0 album が完了した（7 秒）。続けて走る verify は `ok: true`、problems 0 件。`--quick` も `ok: true`（4 件とも R2 の記録した checksum で照合）
- 止まった回に予約だけ済んだ upload 2 件が、verify の notes と `pnpm storage audit --deep` に `expired_upload` として出た。破損は 0 件
- restore 後の 4 枚は、backup と `uploadedBy`・`createdAt`・`takenAt` が一致した（SHA-256 で対応づけ）
- restore 先を Browser（Chromium）で開き、timeline の thumbnail、viewer、original のダウンロード、album の共有と revoke まで通った。CSP 違反は 0 件
- token 付きの `pnpm diagnose` は、private API・`APP_ORIGIN`・D1 schema・CSP・share が PASS した。`r2: CORS` だけが FAIL だった。diagnose は bucket を `wrangler.jsonc` から読むため、そこに無い drill 環境では production の bucket に restore-test の origin で preflight を送る。restore-test の bucket の CORS は `cors list` で確かめた
- 終了後に R2 の object 15 個を消して bucket を削除し、Worker と D1 も削除した（Worker の URL は `404`）。R2 API token の削除は利用者が行う。backup のコピーは作業用のディレクトリに置いた

## ダークモード（2026-09-26）

OS の `prefers-color-scheme` に追従する dark を足した。chrome の token だけを置き換え、stage token と `favorite` は変えていない。

コントラスト（oklch から sRGB に変換して計算）: dark で文字/地 15.8、補足の文字/地 7.3、補足の文字/`muted` 6.3、accent/地 7.8、`destructive`/地 6.7、塗りのボタンと選択の check と赤いボタンの文字 6.7〜15.8。hairline/地は 1.38（light は 1.25）。light の値は変えていない。

確認方法: local の dev を Playwright（Chromium、1280px）で `colorScheme` を dark / light にして開き、timeline、選択中の tile と選択 bar、upload 状況、新規アルバムの dialog と input の focus、viewer の上の menu、Undo 付きの toast を撮って見た。dark では既存の影だけでは dialog と info toast の境界が弱く、地に溶けて見えたので、両方の縁に dark だけ hairline を出した。

`e2e/theme.spec.ts` は、両方の scheme で次を確かめる。

- private app と共有ページの地と文字の明るさ、header の hairline
- error toast の閉じるボタンが、hover で toast の文字の側へ濃くなること。最初は info toast と同じ白の重ねを使っていて、dark の明るい赤の上では地から離れる向きに変わっていた。この検査は、直す前の実装では dark だけで落ちた

`e2e/mobile.spec.ts` は、dark の phone（iPhone 13 の WebKit）で下のタブの地、上の hairline、現在のタブの文字を確かめる。

撮っていないもの: phone の下のタブ、塗りの赤いボタン、error toast。上の検査と、token のコントラストの計算で確かめた。

`pnpm test:e2e` の全体は、PR の CI で通った。

## 「管理」と「メンテナンス」の分離（2026-09-26）

local の dev を Playwright の Chromium（1280px）と iPhone 13 の WebKit で開き、「管理」と「メンテナンス」を撮って見た（[D-039](decisions.md)）。diagnostics と storage audit を差し替え、条件付きの表示をすべて出した状態で撮った。未完了のアップロード 123（うち期限切れ 12）、中断した完全削除、12 月 31 日の日時、点検結果のすべての分類、作り直しと整理のボタン。

- 1280px: どちらも本文の幅に収まり、「メンテナンス」の「← 管理」は desktop でも出る。ヘッダーの「管理」は「メンテナンス」を開いている間も現在のタブのまま
- iPhone 13: 横スクロールは無い。「バックアップ処理の完了日時」と日時（`12/31/2026, 11:59:59 PM`）は 1 行に収まった。メンテナンスへのリンクの説明は 3 行に折り返し、右の `›` は位置を保った
- Chromium の dark でも「メンテナンス」を撮り、ボタンと文字が読めることを見た。`emulateMedia` で切り替えた直後に撮ると、色の transition の途中で薄いボタンが写る。読み込み前に dark にして撮り直した画像では、ボタンは通常どおりだった
- WebKit で screenshot を撮ると、fixture が `style-src-elem` の違反を報告した。同じ「管理」を開いて screenshot の有無だけを変えると、撮ったときだけ違反が出た。app の違反ではなく撮影によるもの。同じ 2 画面を通る `e2e/mobile.spec.ts` は、CSP の検査を付けたまま違反 0 件で通った
- review を受けて、「管理」の期限切れのアップロードの説明に「メンテナンスを開く」のリンクを足し、「状態」のゴミ箱の行を外した（件数はゴミ箱へのリンクに出る）。1280px と iPhone 13 で撮り直し、リンクが説明の直後に出ることを見た
- さらに、未完了のアップロードと削除処理中を 0 のときは出さないようにし、タブのアイコンをスライダーに替え、「写真とアルバムの情報をダウンロード」を外した。何も無い状態の「管理」（写真・アルバムの 2 行とメンテナンスへのリンクだけ）と、点検だけになった「メンテナンス」を、1280px と iPhone 13 で撮って見た

`e2e/manage.spec.ts`（`e2e/library.spec.ts` から名前を変えた）は次を確かめる。文言の全文ではなく、行・リンク・ボタンの有無と移動先を見る。

- 下部ナビに「ライブラリ」のリンクが無く、「管理」がある
- 何も無いときの「管理」は、写真とアルバムの行、件数付きのゴミ箱へのリンクだけで、未完了のアップロード・削除処理中・ゴミ箱の行と「メンテナンスを開く」が無い
- 未完了のアップロードと削除処理中が 1 件以上あると行が出て、期限切れがあれば「メンテナンスを開く」から「メンテナンス」へ移れる
- 「管理」にバックアップ処理の日時・点検・作り直しが無く、「メンテナンス」にはある。「メンテナンス」にダウンロードのボタンは無い
- 点検の損傷は「要対応」の文字で示す
- 両画面の文字に運用の用語と「管理者」「権限」が無い
- `/settings/maintenance` を直接開いて点検できる

`e2e/mobile.spec.ts` は phone で「管理」→「メンテナンス」→「管理」と移る。

## ライブラリ画面の文言（2026-09-26）

local の dev を Playwright（Chromium 1280px と iPhone 13）で開き、「バックアップ処理の完了日時」に日時を入れた状態で、点検を実行して撮って見た。日時は ISO 文字列ではなく端末の locale で表示される。

`e2e/library.spec.ts` は、diagnostics と storage audit を差し替えて条件付きの文言をすべて出し、主要なラベルと説明文があること、画面に `pnpm`・`manifest`・`SHA-256`・`D1`・`R2`・`migration`・`backup`・`docs/` が無いことを確かめる。`tests/unit/storage-check.test.ts` は、点検のすべての分類の説明文に同じ語が無いことを確かめる。

## 未検証

### private app の CSP を production で確かめる

deploy した後に行う。

1. `pnpm diagnose` を token 付きで実行する。`share: asset miss` と `private app: CSP` が PASS。FAIL なら deploy が古いか、`R2_ACCOUNT_ID` が違う。2026-09-25 に production で済み（上の「private app の CSP」）
2. Browser の開発者ツールの console を開いたまま、写真を 1 枚 upload し、timeline・viewer（preview）・original のダウンロード・共有ページを開く。`Content Security Policy` の違反が 0 件なら合格。1 件でもあれば、その directive と blocked URL（query を除く）を記録し、deploy を戻すか policy を直す。2026-09-25 に production の desktop で済み
3. 実機（iPhone Safari、Android Chrome）でも 2 と同じ操作をする（[実機での取り込み](#iphone--android-実機での取り込み)）。desktop の Chromium・WebKit では 2026-09-25 に自動操作でも確かめた（上の「家族の写真を入れる前の production 確認」）

### Access の independent MFA

有効にする場合の確認です（[D-038](decisions.md)、[MFA を足す](operations.md#mfa-を足す推奨)）。remote-test で先に行い、production では household の全員が登録するまで家族の写真を入れない。

- 登録済みの member が OTP だけを入力した段階では、private app と `/api/v1/me` に届かない。MFA を通すと届く。届けば不合格
- `/share/{shareId}` は MFA も login も無しで開ける。login を求められれば不合格（Bypass の application を変えていない）
- `cloudflared access login` で取った token で `pnpm diagnose` が通る。取得の途中で MFA が求められるかを記録する
- 管理者が dashboard で各 member の authenticator を確かめ、本人の登録した数と一致する。一致しなければ削除して登録し直させる
- 1 人の authenticator を管理者が削除すると、その member は次の login で登録をやり直せる（復旧手順）


### iPhone / Android 実機での取り込み

未確認です。desktop の WebKit では代用できません。[roadmap.md](roadmap.md) の Post-merge verification で確認します。

iPhone Safari:

- 48MP の HEIC を複数選択する。iOS Safari の memory 上限（jetsam）と 48MP 以上の decode を見る。落ちる場合は前処理の並列数 1 を試す（[D-020](decisions.md)）
- 写真ピッカーが実際に何を渡すかを確かめる。`accept` に `image/heic` と `image/heif` を含めた状態で、HEIC を選んだときに原本の HEIC が届くか、JPEG に変換されるか。EdgePhotos が記録する形式が、届いた bytes と一致していること（[D-030](decisions.md)）
- JPEG を選んだときに HEIC へ transcode されないこと。WebKit で報告され修正された挙動が、利用中の Safari に残っていないかを見る
- 実機の HEIC（向きを EXIF ではなく `irot` / `imir` で持つもの）で、thumbnail / preview の向きが合うこと
- iCloud にしかない写真を選ぶ
- 100〜200 枚を選ぶ
- upload 中に画面をロックする、Safari を background へ移す、Wi-Fi とモバイル回線を切り替える
- 10 分を超えて中断し、presigned URL の期限（600 秒）切れを踏む
- 位置情報の扱いを確認する。original に GPS が残るか、ピッカーの「オプション」で外れるか

Android: 上と同じ項目のうち該当するもの（HEIF 設定の端末を含む）。

### 2 人の household での利用

Worker 側の household 判定は test で担保しています（`tests/integration/household.test.ts`）。実環境でしか分からないのは、Access policy の Allow 一覧と `HOUSEHOLD_EMAILS` が揃っているか、そして 2 人が日常の操作で困らないかです（[D-028](decisions.md)、[Cloudflare Access](operations.md#4-cloudflare-access)）。

remote-test に 2 アカウントを設定し、実機 2 台で次を確認します。

- 1 人目が写真を 5 枚 upload し、2 人目が login してその 5 枚を見る
- 2 人目が別の 5 枚を upload し、1 人目の timeline に出る
- 同じ写真を双方から upload したとき、duplicate の表示で迷わない
- 2 人目が album を作り、1 人目がそこへ写真を追加する
- original を双方から開く
- 片方が trash し、もう片方が restore する
- logout / login しても続きから使える
- 許可していない 3 つ目のアカウントは入れない
- 2 人がそれぞれ upload した写真の「最初に追加した人」に、それぞれの email が出る（[D-034](decisions.md)）
