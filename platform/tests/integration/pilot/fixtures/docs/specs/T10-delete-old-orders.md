# T10 5年以上前の受注の削除 / Delete orders older than 5 years

| 項目 / Item | 値 / Value |
|---|---|
| リスク区分 / Risk tier | Critical (D-09 §7) |
| 関連機能 / Related features | F2, F4, F5 |

> リスク区分と自律レベルはプラットフォームが決める。この表は人のための参考情報。
> The platform decides the risk tier and the autonomy level. This table is for people.

## 目的 / Purpose

受注日から5年を超えた受注を削除し、データベースを小さく保つ。
Delete orders whose order date is more than 5 years ago, to keep the database small.

## 現状 / Current behaviour

- 受注、受注明細、在庫移動は削除されない。/ Orders, order lines and stock movements are never deleted.
- 在庫移動の一部（理由 `order`）は受注から作られている。/ Some stock movements (reason `order`) come from orders.

## 受入基準 / Acceptance criteria

- AC1: コマンド `pnpm --filter @pilot/api orders:purge` を追加する。受注日時が実行日の5年前より前の受注を削除する。
  Add the command `pnpm --filter @pilot/api orders:purge`. It deletes orders whose order date is before the day 5 years before the run.
- AC2: 対象の受注の明細も削除する。受注から作られた在庫移動は削除しない。在庫移動は外部キー（`order_id`）で受注を参照しているため、受注番号を在庫移動に保存してから参照を外す（新しいマイグレーション）。
  The lines of those orders are deleted too. Stock movements created by those orders are kept. Stock movements refer to orders by a foreign key (`order_id`), so the order number is first stored on the stock movement and then the link is removed (a new migration).
- AC3: 在庫数（`inventory_items`）は変えない。/ The stock quantities (`inventory_items`) do not change.
- AC4: 既定は確認のみ（件数を表示して何も削除しない）。`--execute` を付けたときだけ削除する。
  By default the command only reports the count and deletes nothing. It deletes only with `--execute`.
- AC5: 削除は1つのトランザクションで行い、削除した件数を表示する。
  The deletion runs in one transaction and reports how many orders it deleted.
- AC6: 統合テストで、境界（ちょうど5年前の前後）、明細の削除、在庫移動と在庫数が残ることを確認する。
  Integration tests check the boundary (just before and just after 5 years), that the lines are deleted, and that stock movements and quantities stay.

## 対象外 / Out of scope

- 定期実行（スケジューラ） / Running the command on a schedule
- 削除前のアーカイブ・バックアップ / Archiving or backing up the data before deletion
- 顧客・商品の削除 / Deleting customers or products

## なぜエージェントは実行されないか（人のための説明） / Why the platform refuses to run an agent (for people)

この節は人が読むための説明であり、作業の指示ではない。
This section explains the task to people. It is not an instruction for the work.

- 業務記録を完全に削除する。削除したデータは元に戻せない。
  It deletes business records for good. Deleted data cannot be restored.
- 帳簿や取引記録には保存期間の決まりがある場合があり、5年で消してよいかは人（業務責任者、必要なら専門家）が判断する必要がある。
  Business and accounting records may have a required keeping period. People (the business owner, and an expert if needed) must decide whether 5 years is allowed.
- 受注・明細・在庫移動のすべてに関わり、誤りの影響が大きい。
  It touches orders, order lines and stock movements, so a mistake has a large effect.
- そのため D-09 §7 ではリスク区分 Critical、自律レベル L0 としている。プラットフォームはこのタスクでエージェントを実行しない（ゲート G4 で拒否する）。人が設計・実装・レビューする。
  So D-09 §7 sets risk tier Critical and autonomy L0. The platform does not run an agent for this task (gate G4 refuses the run). People design, build and review it.
