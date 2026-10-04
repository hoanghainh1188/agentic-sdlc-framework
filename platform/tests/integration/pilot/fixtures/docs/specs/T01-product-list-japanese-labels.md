# T01 商品一覧画面の日本語表示 / Japanese labels on the product list screen

| 項目 / Item | 値 / Value |
|---|---|
| リスク区分 / Risk tier | Low (D-09 §7) |
| 関連機能 / Related features | F1 |

> リスク区分と自律レベルはプラットフォームが決める。この表は人のための参考情報。
> The platform decides the risk tier and the autonomy level. This table is for people.

## 目的 / Purpose

倉庫・営業担当者が商品一覧画面を日本語で読めるようにする。
Warehouse and sales staff can read the product list screen in Japanese.

## 現状 / Current behaviour

- 商品一覧画面（`/products`）の見出し、列名、ボタン、空の表示は英語。
  The product list screen (`/products`) shows its heading, column names, button and empty message in English.
- 販売状態は `On sale` / `Discontinued` と表示される。
  The sales status shows as `On sale` / `Discontinued`.

## 受入基準 / Acceptance criteria

- AC1: 商品一覧画面の文言を次の日本語にする。
  The product list screen shows these Japanese texts.

  | 現在 / Now | 変更後 / New |
  |---|---|
  | Products | 商品一覧 |
  | New product | 商品を登録 |
  | SKU | SKU |
  | Name | 商品名 |
  | Price | 価格 |
  | Sales status | 販売状態 |
  | No products yet. | 商品はまだ登録されていません。 |

- AC2: 販売状態を `on_sale` → 販売中、`discontinued` → 販売終了 と表示する。
  The sales status shows 販売中 for `on_sale` and 販売終了 for `discontinued`.
  販売状態の表示ラベルを他の画面と共有している場合、その画面も同じ日本語になってよい。
  If other screens share the sales status labels, they may show the same Japanese labels.
- AC3: API の値（`on_sale` / `discontinued`）と API の応答は変えない。
  The API values (`on_sale` / `discontinued`) and the API responses do not change.
- AC4: 価格の表示形式（円、3桁区切り）は変えない。
  The price format (yen, thousands separators) does not change.
- AC5: 商品一覧画面のコンポーネントテストで AC1 と AC2 を確認する。
  A component test of the product list screen checks AC1 and AC2.

## 対象外 / Out of scope

- 他の画面（商品詳細、登録・編集、在庫、顧客、受注）の日本語化 / Japanese labels on other screens (product detail, create and edit, inventory, customers, orders)
- 多言語対応の仕組み（i18n ライブラリ、言語切り替え） / An i18n library or a language switch
- API とデータベースの変更 / Changes to the API or the database
