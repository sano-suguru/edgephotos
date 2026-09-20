# 変更の記録

この文書は、完了した実装段階を新しい順に記録します。

これからの作業は [roadmap.md](roadmap.md) にあります。各段階の判断は [decisions.md](decisions.md)、確認内容は [verification.md](verification.md)、数値は [benchmarks.md](benchmarks.md) にあります。

## derivative の作り直し（2026-09-18）

`missing_derivative` を、original に触れずに直せるようにした段階です。判断は [D-026](decisions.md) にあります。

- ✅ `POST /api/v1/assets/{assetId}/derivatives/repair`（state を持たない冪等な 1 呼び出し。original は読むだけ）
- ✅ Browser の既存 derivative pipeline の再利用（upload と同じ renderer・長辺・metadata 除去）
- ✅ 作り直しの前後で original の SHA-256・asset ID・album・favorite・trash・日時が変わらないことの回帰テスト
- ✅ object を 1 つも削除しない。使えない derivative は検査時点の ETag への `If-Match` で置き換える（古い repair が新しい結果を取り消せない）
- ✅ ライブラリ画面の「サムネイルを作り直す」と、`pnpm diagnose` の `r2: CORS` が `GET` も検査すること
- ✅ remote-test: bucket の CORS が `GET` を許し、実 R2 の preflight が app origin にだけ `Access-Control-Allow-Origin` を返すこと（設定変更は不要だった）

残っている確認（Browser からの往復と `If-Match` 付き presigned PUT）は、[roadmap.md](roadmap.md) の Release polish にあります。

## 長期保管の整合性（2026-09-17）

機能は足さず、長く預けたライブラリが壊れない・壊れたら分かる・戻せることを優先した段階です。判断は [D-023](decisions.md) と [D-024](decisions.md) にあります。

- ✅ 完全削除と同時に trash から復元された写真を削除しない。finalize の UNIQUE 競合で自分の object を消さない
- ✅ D1 / R2 の突合（storage audit、`--deep` で R2 の SHA-256 記録と照合）と、中断した upload の cleanup
- ✅ export のページ分割（10 万枚で 1 response 55 MiB だった）
- ✅ 差分 backup、backup ディレクトリのオフライン検査、1 枚の破損で止まらない backup
- ✅ 再開できる restore、`createdAt` と並び順の保持、verify の `--quick` と storage audit
- ✅ favorites / trash / 止まった削除の部分 index、diagnostics の走査削減、album cover を一覧で返す
- ✅ 失敗した upload の再試行で転送をやり直さない。失敗表示に「追加されたか・次に何をするか」を出す。アップロード中にタブを閉じる前の確認
- ✅ 元ファイルの形式を中身で判定する。「オリジナル」を「保存したファイル」と表記する
- ✅ 1,000 / 10,000 / 100,000 件の scale 測定

## 継続利用のための堅牢化（2026-09-17）

新しい構成は足さず、測って弱点だけを直した段階です。

- ✅ Browser 固有の経路の Playwright 自動化（[D-021](decisions.md)）
- ✅ read-only の設定診断 `pnpm diagnose`（[operations.md](operations.md) §7）
- ✅ 1,000 / 10,000 件の scale 測定
- ✅ Actions の SHA 固定、Dependabot、release / rollback / credential 更新 / 復旧 drill の手順（operations.md §8、§13、§14）
- ✅ 止まった完全削除の再開と、それに伴う再 upload の不具合の修正（[D-014](decisions.md)）
- ✅ 取り込みの並列数の上限修正（[D-020](decisions.md)）と、100MB 超の事前拒否
- ✅ 期限切れ upload の件数表示、`APP_ORIGIN` の不一致検出、撮影日時の offset が無い場合の扱いの明文化（architecture.md §6）
