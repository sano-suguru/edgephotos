# 測定

1,000〜100,000 asset を想定した scale と、Browser で取り込むときの memory を測ります。測定結果と、それに基づく判断を記録します。

測定は合成データと公開サンプルで行い、利用者の写真は使っていません。

再測定:

```bash
pnpm bench      # tests/bench/scale.bench.ts（local workerd。assert はせず数値を表示する）
BENCH_SIZES=100000 BENCH_BACKUP_MAX=0 BENCH_BIG_ALBUM=50000 pnpm bench
```

## 環境（2026-09-17）

- macOS / Apple Silicon、Node 24.19、`@cloudflare/vitest-pool-workers` の workerd と Miniflare（D1 は SQLite、R2 は local）
- API は実際の SigV4 signer（偽の credential）で URL を署名して測った。ネットワーク遅延は含まない
- `rows_read` は、app が実際に発行した SQL を記録し、同じ bind 値で再実行して取った
- remote の往復時間は remote-test で実測した（read-only。次の表）
- Browser は `vite dev`（development build）に 10,000 件を投入し、Playwright の Chromium と WebKit で測った
- Browser の測定では、画像を route で 22KB の JPEG に差し替えた。R2 と転送時間は含まない

remote-test の往復時間（中央値、東京から）:

| request | ms |
| --- | --- |
| `GET /api/v1/me` | 19 |
| `GET /api/v1/assets?limit=60` | 35 |
| `GET /api/v1/assets/{id}`、`/original` | 31〜33 |
| `GET /api/v1/export`（数件。現在は paged export に置き換え） | 67 |
| R2 presigned GET（小さい thumbnail） | 105 |

## 100,000 件（local、中央値、2026-09-17）

合成 100,000 件です。1% favorite、5% trash、21 album で、大きい album は 5,000 枚と 50,000 枚の 2 通りを用意しました。

矢印の左が修正前、右が修正後です（[D-023](decisions.md)、[D-024](decisions.md)、部分 index）。

| 操作 | 時間 | rows_read |
| --- | --- | --- |
| timeline 1 ページ目（60 / 200） | 3〜5 / 8〜12 ms | 64 / 212 |
| timeline 最終ページ（60） | 3〜5 ms | 65 |
| timeline を 200 件ずつ全件（475 ページ） | 4.1〜5.3 s | |
| favorites 1 ページ目（1%） | 5 → 3 ms | 6,004 → **61** |
| favorites 最終ページ（200） | 14 → 8 ms | 20,133 → **201** |
| trash 最終ページ（200） | 10 → 8 ms | 4,022 → **201** |
| export（1 response） | **1,082 ms / 55 MiB** | 100,000 + 27,000 |
| export assets 1 ページ（1,000） | 8〜11 ms / 543 KiB | 1,001 |
| export album-assets 1 ページ（1,000） | 3〜4 ms / 98 KiB | 2,002 |
| diagnostics | 39〜41 → **3〜4** ms | 400,022 → **105,023** |
| album 一覧（21 album、5,000 枚の album を含む） | 9〜16 ms | 18,062 |
| album 一覧（cover 付き） | 12 KiB | 一覧と同じ（album ごとの request 21 回が不要になる） |
| album の 1 ページ目（5,000 枚 / 50,000 枚） | 8〜9 / **65** ms | 14,751 / **147,501** |
| album 取得（件数、50,000 枚） | 93 ms | |
| 共有 album の 1 ページ目（50,000 枚） | 111 ms | |
| album 一覧（50,000 枚の album を含む） | 65〜78 ms | |
| album 削除（5,000 枚 / 50,000 枚） | 14 / 396 ms | |
| storage audit 1 ページ（500） | 779 ms（最初のページ）、deep 873 ms | assets 501 |
| storage audit 全件（200 ページ） | 16 s（1 ページ平均 80 ms） | |

**最初に劣化したのは export でした。** 1 response の JSON が 55 MiB になりました。Worker の memory 上限（128 MB）に行 object と文字列を同時に持つため、remote では失敗する見込みでした。ページに分けました（[D-024](decisions.md)）。

**修正後に最初に劣化するのは、大きな album です。** album の page・件数・共有ページが、album の枚数に比例して読みます（50,000 枚で 1 ページ約 15 万行、65〜111 ms）。Workers Free の D1 上限（1 日 500 万行）なら、このページを 1 日 34 回開くと上限に達します。

直すには `album_assets` に `sort_at` を持たせる非正規化とデータ移行が要るため、今回は見送りました（[roadmap.md](roadmap.md) の既知の制約）。

**storage audit の最初のページが遅いのは、Miniflare の事情です。** layout 外の key を探す `delimiter` 付きの list が、Miniflare では bucket 全体を走査します。2 ページ目以降は list 2〜3 回と D1 2 回です。R2 の list は I/O で、Worker の CPU はほとんど使いません。実 R2 での時間は未測定です。

**timeline は 10,000 件と同じです。** page の深さにも library の大きさにもよりません。

## API（local、中央値）

| 操作 | 1,000 件 | 10,000 件 | rows_read（10,000 件） |
| --- | --- | --- | --- |
| timeline 1 ページ目（60） | 5 → **3** ms | 5 → **4** ms（69 → 45 KiB） | 64 |
| timeline 1 ページ目（200 = 上限） | 14 → **8** ms | 15 → **9** ms（229 → 149 KiB） | 212 |
| timeline 最終ページ（60） | 4 → 2 ms | 4 → 3 ms | 9,959 → **65**（修正後） |
| timeline を 200 件ずつ全件 | 68 ms | 693 ms（48 ページ） | |
| favorites 1 ページ目（1%） | 1 ms | 6 ms | 6,001 |
| trash 1 ページ目（5%） | 4 ms | 5 ms | 1,211 |
| album 一覧（21 album） | 1 ms | 5 ms | 18,062 |
| album の 1 ページ目（5,000 枚の album） | 5 ms | 8 ms | 14,751 + 存在確認 10,002 → **1** |
| album へ追加 / から削除 | 1〜2 ms | 1〜3 ms | 10,004 → **1**（修正後） |
| 共有 album の 1 ページ目（120） | 6 ms | 8 ms | 14,751 |
| album 削除（5,000 枚） | | 17 ms | |
| export manifest | 11 ms / 600 KiB | 84 ms / 5.8 MiB | 37,042 |
| diagnostics | 1 ms | 3 ms | 30,022 |

矢印の左は修正前、右は一覧で thumbnail だけを署名する修正（[D-022](decisions.md)）の後です。

### 署名の cost

CPU だけの cost（Node、同じ V8。warm-up 後の中央値、2 回測定）:

| 処理 | ms |
| --- | --- |
| 最初の 1 回（isolate の起動直後） | 16〜41 |
| SigV4 の presign 60 回（修正後の timeline 1 ページ） | 3.5〜4.2 |
| SigV4 の presign 120 回（修正前の timeline 1 ページ） | 7.8〜8.3 |
| SigV4 の presign 400 回（修正前の limit=200） | 約 20 |
| export の `JSON.stringify`（1,000 / 10,000 件） | 1.1 / 10.6 |

## Query plan

remote-test の D1 に、同じ SQL を bind parameter 付きで `EXPLAIN QUERY PLAN` した結果（D1 の REST query API。read-only）:

| cursor の書き方 | plan |
| --- | --- |
| `(sort_at < ? OR (sort_at = ? AND id < ?))`（修正前） | `SCAN a USING INDEX assets_timeline` |
| `(sort_at, id) < (?, ?)`（修正後） | `SEARCH a USING INDEX assets_timeline ((sort_at,id)<(?,?))` |

値を literal で埋め込むと、修正前の形でも `SEARCH` になります。app は bind するので、本番でも修正前は index を先頭から走査していました。

その他の plan（local、10,000 件）:

- timeline / favorites / trash: `SCAN a USING INDEX assets_timeline`。先頭から条件に合う行を 61 件集めて止まる。favorites は 1% なので約 6,000 行を読む
- album の page: `SEARCH aa USING COVERING INDEX (album_id=?)` → `SEARCH a (id=?)` → `USE TEMP B-TREE FOR ORDER BY`。album の全 member を読んで並べ替える
- album の件数: member ごとの相関 subquery。album 一覧は全 album の member 数の合計を読む
- export: assets を全件、membership を全件 join
- diagnostics: assets を 3 回全件 scan

## Backup / restore（local、API 経由の逐次処理）

| 操作 | 1,000 件 | 10,000 件 | request 数（10,000 件） |
| --- | --- | --- | --- |
| `backupLibrary`（original + derivative） | 3.2〜5.0 s | 34〜48 s | API 20,020 + storage GET 30,000 |
| `backupLibrary`（2 回目、変更なし） | 0.0 s | 0.2 s | API 20 + storage GET 0 |
| `verifyLibrary` | 1.5 s | 15〜20 s | API 10,040 + storage GET 10,000 |
| `verifyLibrary --quick` | 0.2 s | 2.7 s | API 40 + storage GET 0 |
| `restoreLibrary`（空の環境へ） | 10〜20 s | 100〜150 s | API 29,625 + storage PUT 30,000 |

幅は複数回の測定の範囲です（2026-09-17。後の回は paged export と storage audit を含む）。

どちらも asset 数に比例しました。10,000 件でも memory と D1 の上限には当たりません（manifest は 5.8 MiB）。

remote での見積もり（上の往復時間から。original の転送時間は含まない）:

- backup: API 20,000 × 約 30 ms + storage GET 30,000 × 約 105 ms ≒ 1 時間
- restore: API 約 30,000 × 30〜50 ms + storage PUT 30,000 × 約 100 ms 以上 ≒ 1〜1.5 時間
- original が 1 枚 3 MB なら 10,000 件で 30 GB。回線次第で、転送時間も同じ桁になる

## Browser（10,000 件、`vite dev`）

| 項目 | Chromium | WebKit |
| --- | --- | --- |
| timeline の最初の tile | 398 ms（FCP 216 ms） | 349 ms（FCP 211 ms） |
| 最初の表示で取得する thumbnail | 60 | 60 |
| 「さらに読み込む」1 回（1,000 件表示時） | 70 ms | 104 ms |
| 同（3,000 件） | 79 ms | 192 ms |
| 同（6,000 件） | 114 ms | 437 ms |
| 同（10,000 件） | 147 ms（最大 274） | 816 ms（最大 1,437） |
| JS heap / DOM node（10,000 件表示時） | 64 MB / 30,487 | 取得不可 |
| 10,000 件表示時に viewer を開く | 206 ms | 1,316 ms |
| お気に入りへ移動 | 139 ms | 227 ms |

production build の bundle（gzip）: app 83 KB、共通 CSS / JS 14 KB、共有ページ 1.5 KB。

期限切れ URL の回復（[D-021](decisions.md)）の cost は、1,020 件表示時の Chromium で API 17 回でした。表示済みの thumbnail は再取得しません（修正前の実装では 1,021 枚を取り直していた）。1 分以内に次の失敗が起きても再取得しません。

## Browser の取り込み memory（2026-09-17）

local の `vite dev`、Playwright の Chromium 151 と WebKit 26.5、macOS。

Browser のプロセスツリーの RSS を 50ms ごとに採取し、1 枚処理中の増分を記録した。画像は [verification.md](verification.md) の「Browser での取り込み」と同じ。

| 画素数 | 1 枚処理中の RSS 増分 |
| --- | --- |
| 12MP | 約 45〜110MB |
| 48MP / 50MP | 約 190〜340MB |
| 108MP | 約 440〜840MB |
| 200MP | 約 0.9〜1.1GB |

decode 後の bitmap（幅 × 高さ × 4 byte）が支配的で、original の ArrayBuffer（最大 23MB）は小さい。

200 件の連続 upload（計 920MB、48MP / 50MP を 6 件含む）で、RSS は単調増加しなかった。peak は Chromium 約 1.1GB、WebKit 約 0.9GB（WebContent 単体では約 0.6GB）。

前処理の並列数（48MP を 6 件）:

| 並列数 | Chromium の増分 / 所要時間 | WebKit の増分 / 所要時間 |
| --- | --- | --- |
| 1 | 420MB / 2.0 秒 | 527MB / 約 2.3 秒 |
| 2 | 682MB / 1.6 秒 | 481MB / 約 2.3 秒 |
| 3 | 975MB / 1.5 秒 | 522MB / 約 2.3 秒 |

判断は [D-020](decisions.md)。

## 判断

### 変更したもの

| 項目 | 根拠 | 変更 |
| --- | --- | --- |
| export のページ分割 | 100,000 件で 1 response 55 MiB、1 秒（上の表） | 3 つの paged endpoint と client 側の組み立て（[D-024](decisions.md)） |
| favorites / trash / 止まった削除の部分 index | 件数の少ない filter の最終ページが library の残りを読む（favorites で 20,133 行） | 部分 index と、条件を literal で書いた SQL。ページあたり約 200 行 |
| diagnostics の走査 | ライブラリ画面を開くたびに assets を 4 回全件走査（40 万行） | 全件は `COUNT(*)` 1 回、trash と削除中は部分 index |
| album cover | album ごとに `limit=1` の一覧 API を 1 回（同じ member を読む request が album 数だけ） | `GET /api/v1/albums?covers=true` の 1 回で cover を返す。読む行は一覧と同じ |
| 差分 backup | 同じディレクトリへの 2 回目も全 original を download（10,000 件で API 20,000 回と storage GET 30,000 回） | 取得済みの写真を飛ばす。10,000 件で API 20 回、storage 0 回、0.2 秒 |
| verify `--quick` | 全 original を download（10,000 件で 20 秒、API 10,000 回） | R2 の SHA-256 記録と storage audit で確認。API 40 回、download 0、2.7 秒 |
| timeline の cursor | 本番 D1 の plan が `SCAN`。rows_read が page の深さに比例（10,000 件の最終ページで 9,959 行）。D1 は rows read で課金・制限される | row value の比較に書き換え（index は追加していない）。最終ページは 65 行 |
| album の存在確認 | 追加・削除・page 取得・共有の作成のたびに member 数を数えていた（5,000 枚の album で 1 回 10,004 行）。restore で 5,000 枚を album に入れると、合計約 2,500 万行になる | 主キーでの存在確認に置き換え（1 行）。件数が必要な album 取得・一覧はそのまま |
| 期限切れ URL の回復 | 1,020 件表示時に 1,021 枚を再取得していた | 表示済みの thumbnail は URL を差し替えない。読み込みに失敗した thumbnail だけ新しい URL にする |
| backup / restore の再試行 | 10,000 件で約 6 万回の逐次 request。1 回の通信失敗で全体が止まり、restore は空の環境を作り直す必要があった | 冪等な request だけを backoff 付きで最大 4 回試す（D-020 と同じ基準。`412` は保存済み）。作成する request（`POST /uploads`、`POST /albums`）は繰り返さない。応答が失われた reservation を繰り返すと、未完了の upload が増えるため |
| 一覧での preview URL の署名 | timeline 60 件で 120 回署名していた。preview は viewer を開くまで使わない | 一覧では thumbnail だけを署名する（[D-022](decisions.md)）。下の「署名の cost」 |

### 測って、変更しなかったもの

| 項目 | 測定 | 判断 |
| --- | --- | --- |
| favorites / trash 用の index | 10,000 件で 6 ms、6,001 行 | index を追加しない。favorite が 1% より少なく、library がさらに大きくなれば再検討する |
| album の page と共有 album | 5,000 枚の album で 8 ms、1 ページあたり 14,751 行 | 変更しない。album の中身を撮影日時順に返すには、assets 側の値で並べ替える必要がある。非正規化は見合わない |
| album 一覧の件数 | 21 album で 18,062 行、5 ms | 変更しない |
| diagnostics | 30,022 行、3 ms | 変更しない。表示は設定画面と restore 前の確認だけ |
| export | 10,000 件で 84 ms、5.8 MiB | 変更しない。D1 に結果サイズの上限はなく（1 行 2 MB、query 30 秒）、Worker の memory にも余裕がある |
| backup / restore の並列化 | remote で約 1〜1.5 時間（10,000 件）と見積もった。並列化で縮むのは往復時間の分だけで、転送時間は縮まない | 並列化しない。年に数回の操作で、再試行を入れたので途中で止まりにくい |
| restore の再開 | 10,000 件で remote 1〜1.5 時間、100,000 件では 10 時間を超える見積もり。Access token の期限切れだけで最初からになる | 実装した（`--resume`、[D-024](decisions.md)） |
| timeline の仮想スクロール | 10,000 件を手で読み込むと、WebKit で 1 回 0.8 秒、viewer を開くのに 1.3 秒 | 入れない。60 件ずつ 160 回以上押した場合の値で、最初の表示は 60 件のまま速い |
| Queue / Durable Objects / 別 Worker / cache | どの測定でも必要性が出なかった | 追加しない |
| 大きな album の page | 50,000 枚の album で 1 ページ 147,501 行、65 ms | 今回は変更しない。非正規化とデータ移行が要る。Free の rows read 上限で問題になった時点、または体感で遅くなった時点で行う |
| storage cleanup の定期実行 | 手動の実行で件数を 0 にでき、写真の整合性に影響しない | Cron を入れない（[D-023](decisions.md)） |
| 前処理の並列数 | 今回は測っていない（[D-020](decisions.md) の測定のまま） | 2 のまま |

### plan に依存する注意

Workers Free の CPU 上限は 1 request 10 ms です。timeline の 1 ページの署名は、修正前の約 8 ms から約 4 ms になりました。

ただし isolate の起動直後の最初の署名は、それだけで 16〜41 ms かかります。10,000 件の export は `JSON.stringify` だけで約 11 ms です。

Node での測定なので本番の CPU 時間とは一致しません。Free の 10 ms に収まる根拠もありません。

このため、継続利用の手順では Workers Paid（CPU 上限は既定 30 秒）を推奨しています（[セットアップの方針](operations.md#1-セットアップの方針)）。Free でしか使えないことが要件になった場合は、export を分割するなどの対応を、そのとき測って決めます。

D1 の rows read も plan で上限が違います（Free は 1 日 500 万行）。

修正後、timeline を 1 ページ読む cost は page の深さによらず約 60 行です。album 一覧と album の page は、album の大きさに比例します。
