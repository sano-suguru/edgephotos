# セキュリティ報告

To report a vulnerability, please use GitHub's private reporting: [Report a vulnerability](https://github.com/sano-suguru/edgephotos/security/advisories/new). Do not open a public issue.

## 報告の窓口

脆弱性は公開の Issue に書かず、GitHub の [Report a vulnerability](https://github.com/sano-suguru/edgephotos/security/advisories/new) から非公開で報告してください。

再現手順を書くときは、実在の写真、presigned URL、共有リンクの secret、Access の token を含めないでください。

## 対象

EdgePhotos は現在 alpha です（[段階の呼び方](docs/roadmap.md#段階の呼び方)）。リリース版はまだ無く、修正の対象は `main` の最新だけです。

EdgePhotos は利用者がそれぞれの Cloudflare アカウントへデプロイして使います。このリポジトリのコードと、[運用・デプロイ・復元](docs/operations.md) の手順に起因する問題を扱います。個々のデプロイの設定（Access policy など）は、そのデプロイの持ち主が管理します。

## 返答

個人で開発しているため、返答や修正までの期間は約束できません。

## 設計上の保証

何を守り、何を保証しないかは [セキュリティ](docs/security.md) にあります。
