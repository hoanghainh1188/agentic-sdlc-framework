// Runtime tenant guard (design/D-05 D1 and section 8, D-08 A06 AC3).
//
// Every query sent through a tenant scope is checked before it runs. The rules are strict on
// purpose; repository code must be written to satisfy them:
// - Every occurrence of a platform table (in FROM, JOIN, UPDATE, DELETE, USING), in every query
//   level (main query, subqueries, derived tables, CTEs), needs its own condition
//   `<table or alias>.<tenant column> = <this tenant>`. The condition must be in WHERE, or in the
//   ON clause of that table's own JOIN, and must not sit under OR or NOT.
//   An unqualified `tenant_id` counts only when the query level reads exactly one table.
// - INSERT must set the tenant column to this tenant in every row; INSERT … SELECT is rejected.
// - UPDATE must never write the tenant column. INSERT into and UPDATE of `tenants` are rejected:
//   tenants are managed through the system scope only.
//   ON CONFLICT DO UPDATE is rejected: its target row may belong to another tenant.
// - Raw SQL statements, MERGE, schema changes and tables unknown to `TENANT_COLUMN` are rejected.
// Raw SQL *fragments* inside a built query (for example `sql\`lower(email)\``) are allowed; they
// must never reference a table. Code review enforces that.
import type {
  AliasNode,
  ColumnUpdateNode,
  DeleteQueryNode,
  InsertQueryNode,
  JoinNode,
  KyselyPlugin,
  OperationNode,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  QueryResult,
  RootOperationNode,
  SelectQueryNode,
  TableNode,
  UnknownRow,
  UpdateQueryNode,
} from 'kysely';

import { TENANT_COLUMN } from './schema.js';
import { TenantGuardError } from './errors.js';
import type { TenantId } from './tenant-id.js';

type TenantColumns = Readonly<Record<string, string>>;

interface Source {
  table: string;
  /** Name used to qualify columns: the alias, or the table name. */
  ref: string;
  /** Conditions that may scope this source besides WHERE (its JOIN … ON clause). */
  on?: OperationNode;
}

type QueryNode = SelectQueryNode | UpdateQueryNode | DeleteQueryNode | InsertQueryNode;

const QUERY_KINDS = new Set([
  'SelectQueryNode',
  'UpdateQueryNode',
  'DeleteQueryNode',
  'InsertQueryNode',
]);

export class TenantGuardPlugin implements KyselyPlugin {
  constructor(
    private readonly tenantId: TenantId,
    private readonly tenantColumns: TenantColumns = TENANT_COLUMN,
  ) {}

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    assertTenantScoped(args.node, this.tenantId, this.tenantColumns);
    return args.node;
  }

  transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return Promise.resolve(args.result);
  }
}

/** Throws `TenantGuardError` unless every table access in `root` is limited to `tenantId`. */
export function assertTenantScoped(
  root: OperationNode,
  tenantId: string,
  tenantColumns: TenantColumns = TENANT_COLUMN,
): void {
  if (root.kind === 'RawNode') {
    fail('raw_sql', 'raw SQL statements are not allowed in a tenant scope');
  }
  if (!QUERY_KINDS.has(root.kind)) {
    fail('unsupported_statement', `${root.kind} is not allowed in a tenant scope`);
  }
  const queries: QueryNode[] = [];
  const cteNames = new Set<string>();
  collect(root, queries, cteNames);
  for (const name of cteNames) {
    if (Object.hasOwn(tenantColumns, name)) {
      fail('cte_shadows_table', `CTE name "${name}" hides the table of the same name`);
    }
  }
  const checker = new QueryChecker(tenantId, tenantColumns, cteNames);
  for (const query of queries) checker.check(query);
}

/** Collects every query node (any depth) and every CTE name. */
function collect(node: unknown, queries: QueryNode[], cteNames: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collect(item, queries, cteNames);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const kind = (node as { kind?: unknown }).kind;
  if (typeof kind !== 'string') return;
  if (kind === 'MergeQueryNode') {
    fail('unsupported_statement', 'MERGE is not allowed in a tenant scope');
  }
  if (QUERY_KINDS.has(kind)) queries.push(node as QueryNode);
  if (kind === 'CommonTableExpressionNameNode') {
    cteNames.add((node as { table: TableNode }).table.table.identifier.name);
  }
  for (const value of Object.values(node)) collect(value, queries, cteNames);
}

class QueryChecker {
  constructor(
    private readonly tenantId: string,
    private readonly tenantColumns: TenantColumns,
    private readonly cteNames: ReadonlySet<string>,
  ) {}

  check(query: QueryNode): void {
    switch (query.kind) {
      case 'SelectQueryNode':
        this.checkSources(this.sources(query.from?.froms, query.joins), query.where?.where);
        return;
      case 'UpdateQueryNode':
        this.checkSources(
          this.sources(
            [...(query.table ? [query.table] : []), ...(query.from?.froms ?? [])],
            query.joins,
          ),
          query.where?.where,
        );
        this.checkWrites(query.updates, this.tableName(query.table));
        return;
      case 'DeleteQueryNode':
        this.checkSources(
          this.sources([...query.from.froms, ...(query.using?.tables ?? [])], query.joins),
          query.where?.where,
        );
        return;
      case 'InsertQueryNode':
        this.checkInsert(query);
        return;
    }
  }

  private sources(
    froms: readonly OperationNode[] | undefined,
    joins: readonly JoinNode[] | undefined,
  ): Source[] {
    const result: Source[] = [];
    for (const from of froms ?? []) this.addSource(result, from);
    for (const join of joins ?? []) this.addSource(result, join.table, join.on?.on);
    return result;
  }

  private addSource(result: Source[], node: OperationNode, on?: OperationNode): void {
    if (node.kind === 'TableNode') {
      const table = this.tableNameOf(node as TableNode);
      if (table !== undefined) result.push({ table, ref: table, on });
      return;
    }
    if (node.kind === 'AliasNode') {
      const alias = node as AliasNode;
      // Derived tables (subqueries in FROM/JOIN) are checked as their own query level.
      if (alias.node.kind === 'SelectQueryNode') return;
      if (alias.node.kind === 'TableNode' && alias.alias.kind === 'IdentifierNode') {
        const table = this.tableNameOf(alias.node as TableNode);
        const ref = (alias.alias as unknown as { name: string }).name;
        if (table !== undefined) result.push({ table, ref, on });
        return;
      }
    }
    fail('unsupported_statement', `unsupported table source ${node.kind} in a tenant scope`);
  }

  /** Table name, or undefined for a CTE reference. Throws for unknown tables and schemas. */
  private tableNameOf(node: TableNode): string | undefined {
    const schema = node.table.schema?.name;
    const name = node.table.identifier.name;
    if (schema === undefined && this.cteNames.has(name)) return undefined;
    if ((schema !== undefined && schema !== 'public') || !Object.hasOwn(this.tenantColumns, name)) {
      fail('unknown_table', `table "${schema ? `${schema}.` : ''}${name}" is not a tenant table`);
    }
    return name;
  }

  private tableName(node: OperationNode | undefined): string | undefined {
    if (node?.kind === 'TableNode') return this.tableNameOf(node as TableNode);
    if (node?.kind === 'AliasNode') return this.tableName((node as AliasNode).node);
    return undefined;
  }

  private checkSources(sources: Source[], where: OperationNode | undefined): void {
    const whereConditions = conjuncts(where);
    for (const source of sources) {
      const column = this.tenantColumns[source.table]!;
      const candidates = [...whereConditions, ...conjuncts(source.on)];
      const scoped = candidates.some((condition) =>
        this.isTenantCondition(condition, source.ref, column, sources.length === 1),
      );
      if (!scoped) {
        fail(
          'missing_tenant_filter',
          `"${source.ref}" (table ${source.table}) has no "${source.ref}.${column} = <tenant>" condition`,
        );
      }
    }
  }

  private isTenantCondition(
    node: OperationNode,
    ref: string,
    column: string,
    allowUnqualified: boolean,
  ): boolean {
    if (node.kind !== 'BinaryOperationNode') return false;
    const { leftOperand, operator, rightOperand } = node as unknown as {
      leftOperand: OperationNode;
      operator: OperationNode;
      rightOperand: OperationNode;
    };
    if (
      operator.kind !== 'OperatorNode' ||
      (operator as unknown as { operator: string }).operator !== '='
    ) {
      return false;
    }
    const matches = (col: OperationNode, value: OperationNode) =>
      this.isColumnRef(col, ref, column, allowUnqualified) &&
      value.kind === 'ValueNode' &&
      (value as unknown as { value: unknown }).value === this.tenantId;
    return matches(leftOperand, rightOperand) || matches(rightOperand, leftOperand);
  }

  private isColumnRef(
    node: OperationNode,
    ref: string,
    column: string,
    allowUnqualified: boolean,
  ): boolean {
    if (node.kind === 'ColumnNode') {
      return (
        allowUnqualified &&
        identifierName((node as unknown as { column: OperationNode }).column) === column
      );
    }
    if (node.kind !== 'ReferenceNode') return false;
    const reference = node as unknown as { column: OperationNode; table?: TableNode };
    if (reference.column.kind !== 'ColumnNode') return false;
    if (
      identifierName((reference.column as unknown as { column: OperationNode }).column) !== column
    ) {
      return false;
    }
    if (reference.table === undefined) return allowUnqualified;
    const schema = reference.table.table.schema?.name;
    return (
      (schema === undefined || schema === 'public') && reference.table.table.identifier.name === ref
    );
  }

  private checkWrites(
    updates: readonly ColumnUpdateNode[] | undefined,
    table: string | undefined,
  ): void {
    if (table === undefined) return;
    if (table === 'tenants') {
      // A tenant may read its own row, but budget and status are platform-admin decisions.
      fail('unsupported_statement', 'tenants are changed through the system scope only');
    }
    const tenantColumn = this.tenantColumns[table];
    for (const update of updates ?? []) {
      const name = columnName(update.column);
      if (name === tenantColumn || name === 'tenant_id') {
        fail('tenant_column_write', `UPDATE must not change ${table}.${name}`);
      }
    }
  }

  private checkInsert(query: InsertQueryNode): void {
    const table = query.into ? this.tableNameOf(query.into) : undefined;
    if (table === undefined) {
      fail('unsupported_statement', 'INSERT without a platform table is not allowed');
    }
    if (table === 'tenants') {
      fail('unsupported_statement', 'tenants are created through the system scope only');
    }
    if (query.onConflict?.updates !== undefined || query.onConflict?.updateWhere !== undefined) {
      fail('tenant_column_write', 'ON CONFLICT DO UPDATE is not allowed in a tenant scope');
    }
    const column = this.tenantColumns[table]!;
    const index = (query.columns ?? []).findIndex((c) => identifierName(c.column) === column);
    if (index < 0 || query.values?.kind !== 'ValuesNode') {
      fail('insert_without_tenant', `INSERT into ${table} must set ${column} in a VALUES list`);
    }
    const rows = (query.values as unknown as { values: readonly OperationNode[] }).values;
    for (const row of rows) {
      if (!this.rowHasTenant(row, index)) {
        fail(
          'insert_without_tenant',
          `INSERT into ${table}: every row must set ${column} to this tenant`,
        );
      }
    }
  }

  private rowHasTenant(row: OperationNode, index: number): boolean {
    if (row.kind === 'PrimitiveValueListNode') {
      return (row as unknown as { values: readonly unknown[] }).values[index] === this.tenantId;
    }
    if (row.kind === 'ValueListNode') {
      const value = (row as unknown as { values: readonly OperationNode[] }).values[index];
      return (
        value?.kind === 'ValueNode' &&
        (value as unknown as { value: unknown }).value === this.tenantId
      );
    }
    return false;
  }
}

/** Splits a condition into the parts joined by AND. OR / NOT branches are not included. */
function conjuncts(node: OperationNode | undefined): OperationNode[] {
  if (node === undefined) return [];
  if (node.kind === 'AndNode') {
    const { left, right } = node as unknown as { left: OperationNode; right: OperationNode };
    return [...conjuncts(left), ...conjuncts(right)];
  }
  if (node.kind === 'ParensNode')
    return conjuncts((node as unknown as { node: OperationNode }).node);
  return [node];
}

function identifierName(node: OperationNode): string | undefined {
  return node.kind === 'IdentifierNode' ? (node as unknown as { name: string }).name : undefined;
}

function columnName(node: OperationNode): string | undefined {
  if (node.kind === 'ColumnNode')
    return identifierName((node as unknown as { column: OperationNode }).column);
  if (node.kind === 'ReferenceNode') {
    const column = (node as unknown as { column: OperationNode }).column;
    return column.kind === 'ColumnNode' ? columnName(column) : undefined;
  }
  return undefined;
}

function fail(code: TenantGuardError['code'], message: string): never {
  throw new TenantGuardError(code, message);
}
