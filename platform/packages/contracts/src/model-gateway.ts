// Model gateway interface (design/D-03 section 7.4, D-07 sections 3, 5 and 6, D-08 C03,
// design/ADR-M24). The MVP implementation is `@sdlc/adapter-model-litellm` (LiteLLM Proxy). Core
// (the Cost Controller) depends on this interface only, never on LiteLLM (ADR-M16 §2.5).
//
// Money is a decimal string in USD with at most 6 decimals (`"2"`, `"0.0012"`), never a float
// (D-05 D6). Adapters convert at the gateway boundary.
import type { ModelRef } from './policy.js';
import type { RedactedSecret } from './secrets.js';

/** The seven labels every model call carries (D-07 section 5, CLAUDE.md). */
export const COST_LABEL_NAMES = [
  'tenant',
  'project',
  'intent_id',
  'run_id',
  'gate',
  'agent',
  'data_class',
] as const;
export type CostLabelName = (typeof COST_LABEL_NAMES)[number];

/**
 * Label values (D-07 section 5 examples, design/ADR-M24 §2.4): tenant slug, project slug, intent
 * code (`INT-YYYY-NNNN`), run UUID, gate code, agent key, data class. Codes only: no spaces, no
 * `@`, at most 64 characters.
 */
export type CostLabels = Readonly<Record<CostLabelName, string>>;

/** A per-run virtual key. The sandbox receives `key`; the platform keeps `keyId` to revoke it. */
export interface VirtualKey {
  /** Identifier of the key at the gateway (not the key itself). Used to revoke and read spend. */
  readonly keyId: string;
  /** The key the agent sends to the gateway. Call `reveal()` only where it is handed over. */
  readonly key: RedactedSecret;
  /** The key stops working at this time, even if nobody revokes it. */
  readonly expiresAt: Date;
}

export interface CreateRunKey {
  readonly runId: string;
  readonly labels: CostLabels;
  /** Budget cap of the key. The gateway refuses calls once spend reaches it (a backstop, QUESTIONS #14). */
  readonly maxBudgetUsd: string;
  /** Model names the key may call. At least one. */
  readonly models: readonly string[];
  /** Key lifetime. */
  readonly durationMinutes: number;
  /** The tenant's budget group (`ensureTenantBudget`); its spend counts against the tenant cap. */
  readonly tenantGroupId: string;
}

export interface TenantBudget {
  readonly tenantSlug: string;
  /** Monthly cap (UTC calendar month). `null`: no cap at the gateway. */
  readonly monthlyBudgetUsd: string | null;
}

export interface SpendInfo {
  readonly spendUsd: string;
  readonly maxBudgetUsd: string | null;
}

/** One model call as recorded by the gateway. Labels come from the key the call used. */
export interface SpendRecord {
  /** Gateway request ID; stored as `cost_records.source_ref`, unique per tenant. */
  readonly sourceRef: string;
  /** The model name the caller asked for (the name in `allowed_models`). */
  readonly model: string;
  readonly status: 'success' | 'failure';
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly costUsd: string;
  readonly occurredAt: Date;
  /** The labels found on the call. A call made without a platform key has none. */
  readonly labels: Partial<CostLabels>;
}

export interface SpendPage {
  readonly records: readonly SpendRecord[];
  /** Rows the gateway returned that do not have the expected shape (for example a negative cost). */
  readonly unreadable: number;
}

export interface ModelGateway {
  /**
   * Creates or updates the tenant's budget group at the gateway and returns its ID. A `null`
   * budget removes the cap.
   */
  ensureTenantBudget(input: TenantBudget): Promise<{ readonly tenantGroupId: string }>;
  /** Creates a virtual key for one run (D-02 FR-50, FR-51). */
  createRunKey(input: CreateRunKey): Promise<VirtualKey>;
  /** Revokes a key. Revoking a key that no longer exists is not an error. */
  revokeKey(keyId: string): Promise<void>;
  /**
   * Revokes the key of one run, found by the run (task C06 session 2, ADR-M33 §2.6), so the key's
   * ID never has to travel with the run (for example through the Temporal history). No key is not
   * an error.
   */
  revokeRunKey(runId: string): Promise<void>;
  /** Spend of one key so far, as the gateway counts it. */
  getSpend(keyId: string): Promise<SpendInfo>;
  /** Models the gateway serves and where each runs (D-07 section 4; input of the policy engine). */
  listModels(): Promise<ModelRef[]>;
  /**
   * Model calls that started in `[from, to)`, oldest first. A row the adapter cannot read is not
   * returned but counted in `unreadable`, so one bad row never hides the others.
   */
  listSpend(range: { readonly from: Date; readonly to: Date }): Promise<SpendPage>;
}

/** Labels are codes (see `CostLabels`). */
export const COST_LABEL_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
