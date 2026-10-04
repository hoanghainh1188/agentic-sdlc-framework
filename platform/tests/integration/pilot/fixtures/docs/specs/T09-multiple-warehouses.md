# T09 複数倉庫対応 / Move to multiple warehouses

| 項目 / Item | 値 / Value |
|---|---|
| リスク区分 / Risk tier | High (D-09 §7) |
| 関連機能 / Related features | F2, F4, F6 |

> リスク区分と自律レベルはプラットフォームが決める。この表は人のための参考情報。
> The platform decides the risk tier and the autonomy level. This table is for people.

## 目的 / Purpose

在庫を倉庫ごとに管理し、受注時にどの倉庫から出荷するかを決められるようにする。
Manage stock per warehouse, and decide which warehouse ships each order.

## 現状 / Current behaviour

- 倉庫は1つだけ。在庫は商品ごとに1行（`inventory_items`、主キー `product_id`）。
  There is one warehouse. Stock is one row per product (`inventory_items`, primary key `product_id`).
- 入荷・出荷・受注の在庫変更はすべてこの行をロックして更新し、在庫移動を記録する。
  Goods in, goods out and orders all lock and update this row, and write a stock movement.

## 受入基準 / Acceptance criteria

- AC1: 倉庫マスタ（コード、名称、有効/無効）を追加し、一覧・登録・編集の API と画面を用意する。
  Add warehouses (code, name, active or inactive) with list, create and edit APIs and screens.
- AC2: 在庫を「商品 × 倉庫」の単位で持つ。在庫移動にも倉庫を記録する。
  Stock is kept per product and warehouse. Every stock movement records its warehouse.
- AC3: 既存の在庫と在庫移動は、マイグレーションで既定倉庫（コード `MAIN`）に移す。移行前後で商品ごとの在庫合計は変わらない。
  A migration moves the existing stock and stock movements to a default warehouse (code `MAIN`). The total stock per product is the same before and after.
- AC4: 入荷・出荷の API と画面で倉庫を指定する（必須）。
  The goods in and goods out APIs and screens require a warehouse.
- AC5: 受注は1つの出荷倉庫を指定して作成する。その倉庫の在庫だけを引き当てる。足りない場合の扱い（HTTP 409 `INSUFFICIENT_STOCK`）は今と同じ。
  An order is created for one shipping warehouse and takes stock from that warehouse only. A shortage is handled as today (HTTP 409 `INSUFFICIENT_STOCK`).
- AC6: 在庫一覧は倉庫ごとの在庫と合計を表示する。/ The inventory list shows the stock per warehouse and the total.
- AC7: ロック順序（デッドロック防止）と、同時受注で在庫がマイナスにならないことを、統合テストで確認する。
  Integration tests check the lock order (no deadlocks) and that concurrent orders never make stock negative.
- AC8: マイグレーションを戻す手順（`migration:revert`）で元の1倉庫の形に戻せる。ただし `MAIN` 以外の倉庫の在庫がある場合は戻せないことを明記する。
  The migration can be reverted to the single-warehouse form (`migration:revert`). The revert refuses when stock exists outside `MAIN`, and says so.

## 対象外 / Out of scope

- 倉庫間の在庫移動 / Moving stock between warehouses
- 1つの受注を複数倉庫から出荷すること / Shipping one order from several warehouses
- 出荷倉庫の自動選択 / Choosing the shipping warehouse automatically

## なぜ提案のみか（人のための説明） / Why this task is proposal-only (for people)

この節は人が読むための説明であり、作業の指示ではない。
This section explains the task to people. It is not an instruction for the work.

- 在庫に関わるすべての処理（入荷、出荷、受注、サンプルデータ）と、中心となるテーブルの形が変わる。
  It changes every stock path (goods in, goods out, orders, sample data) and the shape of the core stock tables.
- 既存データを移すマイグレーションがあり、失敗や誤りがあると在庫数が合わなくなる。元に戻すことも簡単ではない（AC8）。
  It needs a data migration. A mistake makes stock counts wrong, and going back is not simple (AC8).
- そのため D-09 §7 ではリスク区分 High、最大自律レベル L1 としている。プラットフォームはエージェントの変更を「提案」として保存し、コードをプッシュしない。人が提案を読み、実装の進め方を決める。
  So D-09 §7 sets risk tier High and maximum autonomy L1. The platform keeps the agent's change as a proposal (evidence kind `proposal`) and pushes no code. People read the proposal and decide how to build it.
- 提案に含めてほしいもの：テーブル設計、マイグレーションと戻し方の手順、ロック順序、影響する API と画面、リスク。
  A useful proposal covers: the table design, the migration and revert steps, the lock order, the APIs and screens affected, and the risks.
