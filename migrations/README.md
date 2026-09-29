# migrations

D1 の migration です。作り方は開発ガイドの [D1 / migration](../docs/development.md#7-d1--migration) にあります。ここには、baseline の `0001_initial` の既知の罠だけを書きます。

## `0001_initial` は baseline

`0001_initial.sql` は Drizzle 導入前に手書きした migration で、baseline として扱います。

`0001_initial.sql` は変更しません。production の `d1_migrations` は file 名で記録されているため、改名や再生成もしません。

`migrations/meta/0001_snapshot.json` は、同じ schema を drizzle-kit で生成した snapshot です。journal の entry は `idx: 1` / `tag: 0001_initial` です。drizzle-kit は次の番号を「最後の idx + 1」で決めるため、以後の migration は `0002_*` から始まります。この journal を `idx: 0` へ「直さない」でください。

`0001_initial.sql` と snapshot の差は次の 2 点だけで、どちらも既存データに影響しません。

- SQL 側の TEXT PRIMARY KEY は `NOT NULL` を明示していない（SQLite の歴史的仕様で NULL を受け付ける）。snapshot は `NOT NULL` として扱う。app は常に id を指定する
- `uploads.asset_id` の UNIQUE は、SQL 側では column 制約（無名の autoindex）、snapshot では `uploads_asset_id_unique` という index

この差が原因で生成 SQL が誤っていれば CI で分かります。test の setup は空の D1 へ `0001` から順に全 migration を適用し、drift test が `schema.ts` と比較します。生成 migration は毎回「0001 適用済みの DB に対する rehearsal」を通ります。

rehearsal が保証するのは、DDL として適用できることだけです。table は空なので、既存データの保存（table 作り直し時の列の対応、値の変換、NOT NULL や CHECK の強化）は検証しません。

例: `asset_id` の `.unique()` を外して生成すると `DROP INDEX uploads_asset_id_unique;` になり、setup が `no such index` で失敗します。table を作り直す migration（`__new_uploads` を作ってコピーし、rename する）に手で直すと通ります。

`wrangler` と `readD1Migrations` は `.sql` だけを読むため、`migrations/meta/` は適用対象になりません。
