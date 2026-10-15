// Create or change an evaluation plan (task L05, design/ADR-M82 §2.1, §2.7; QUESTIONS #478). Every
// field is a code, a number, an amount or a repository path: a prompt variant is a file on the
// project's default branch, never text typed here. A plan that runs on a schedule or on a change,
// or a higher budget, is confirmed with a passkey. The API checks everything again.
import type { EvalPlanView } from '@sdlc/api-schemas';
import { useState } from 'preact/hooks';

import { readEvalPlan } from '../api/reads.js';
import { useApi } from '../api/use-api.js';
import { changeEvalPlan, createEvalPlan } from '../api/writes.js';
import { Show, Txt } from '../components/common.js';
import { t } from '../i18n.js';
import {
  DATA_CLASS_CHOICES,
  emptyConfig,
  emptyPlanForm,
  INVALID_FIELD_KEYS,
  MAX_CONFIGURATIONS,
  needsStepUp,
  planBody,
  planFormOf,
  TRIGGER_CHOICE_KEYS,
  WEEKDAY_KEYS,
  type ConfigForm,
  type PlanForm,
} from '../model/evaluations.js';
import { href, planHref } from '../router.js';
import { session } from '../session.js';
import { actionErrorKey } from './EvalPlan.js';
import { confirmWithPasskey } from './eval-step-up.js';

export function EvalPlanNew({ query }: { readonly query: URLSearchParams }) {
  const project = query.get('project') ?? '';
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(project)) {
    return (
      <section class="screen">
        <p class="notice notice-error" role="alert">
          {t('dashboard.eval.no_project')}
        </p>
      </section>
    );
  }
  return <PlanEditor project={project} plan={null} />;
}

export function EvalPlanEdit({ id }: { readonly id: string }) {
  const { result } = useApi((signal) => readEvalPlan(id, { signal }), [id]);
  return (
    <Show loaded={result}>{(plan) => <PlanEditor project={plan.project.slug} plan={plan} />}</Show>
  );
}

function PlanEditor({
  project,
  plan,
}: {
  readonly project: string;
  readonly plan: EvalPlanView | null;
}) {
  const [form, setForm] = useState<PlanForm>(() =>
    plan === null ? emptyPlanForm() : planFormOf(plan),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (change: Partial<PlanForm>) => setForm((f) => ({ ...f, ...change }));
  const setConfig = (index: number, change: Partial<ConfigForm>) =>
    setForm((f) => ({
      ...f,
      configurations: f.configurations.map((c, i) => (i === index ? { ...c, ...change } : c)),
    }));

  if (!session.actions() || (plan !== null && !plan.can_change)) {
    return (
      <section class="screen">
        <p class="notice notice-error" role="alert">
          {t('dashboard.eval.error.no_write')}
        </p>
      </section>
    );
  }

  const submit = async (event: Event) => {
    event.preventDefault();
    setError(null);
    const built = planBody(form, plan === null ? 'create' : 'change');
    if (!built.ok) {
      setError(INVALID_FIELD_KEYS[built.field] ?? 'dashboard.eval.error.failed');
      return;
    }
    const body = plan === null ? built.body : { ...built.body, expected_version: plan.version };
    const before =
      plan === null
        ? null
        : {
            trigger: plan.current.trigger,
            perRun: plan.current.budget_per_run_usd,
            cap: plan.current.monthly_cap_usd,
          };
    setBusy(true);
    try {
      const stepUp = needsStepUp(before, body)
        ? await confirmWithPasskey(
            plan === null ? 'eval_plan.create' : 'eval_plan.change',
            body,
            plan === null ? project : plan.id,
          )
        : undefined;
      const sent = { ...body, ...(stepUp ? { step_up: stepUp } : {}) };
      const saved =
        plan === null ? await createEvalPlan(project, sent) : await changeEvalPlan(plan.id, sent);
      window.location.hash = planHref(saved.id);
    } catch (failure) {
      setError(actionErrorKey(failure));
    } finally {
      setBusy(false);
    }
  };

  const titleKey =
    plan === null ? 'dashboard.eval.form.title_new' : 'dashboard.eval.form.title_edit';
  return (
    <section class="screen" aria-labelledby="plan-form-title">
      <div class="screen-head">
        <div>
          <p class="eyebrow">
            <a href={href('evaluations', { project })}>{t('dashboard.eval.title')}</a> ·{' '}
            <Txt value={project} />
          </p>
          <h1 id="plan-form-title">{t(titleKey)}</h1>
        </div>
      </div>
      <form class="plan-form" onSubmit={(e) => void submit(e)} noValidate>
        {error !== null && (
          <p class="notice notice-error" role="alert">
            {t(error)}
          </p>
        )}
        <fieldset>
          <legend>{t('dashboard.eval.form.what')}</legend>
          {plan === null && (
            <Field label="dashboard.eval.form.code" hint="dashboard.eval.form.code_hint">
              <input
                value={form.code}
                required
                maxLength={48}
                autoComplete="off"
                onInput={(e) => set({ code: e.currentTarget.value })}
              />
            </Field>
          )}
          <Field label="dashboard.eval.form.data_class">
            <select
              value={form.dataClass}
              onChange={(e) => set({ dataClass: e.currentTarget.value })}
            >
              {DATA_CLASS_CHOICES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field label="dashboard.eval.form.task_set">
            <input
              inputMode="numeric"
              value={form.taskSetVersion}
              onInput={(e) => set({ taskSetVersion: e.currentTarget.value })}
            />
          </Field>
          <Field label="dashboard.eval.form.tasks" hint="dashboard.eval.form.tasks_hint">
            <input value={form.taskIds} onInput={(e) => set({ taskIds: e.currentTarget.value })} />
          </Field>
          <Field label="dashboard.eval.form.runs">
            <input
              inputMode="numeric"
              value={form.runsPerTask}
              onInput={(e) => set({ runsPerTask: e.currentTarget.value })}
            />
          </Field>
        </fieldset>

        <fieldset>
          <legend>{t('dashboard.eval.form.budgets')}</legend>
          <Field label="dashboard.eval.form.budget_per_run">
            <input
              inputMode="decimal"
              value={form.budgetPerRunUsd}
              onInput={(e) => set({ budgetPerRunUsd: e.currentTarget.value })}
            />
          </Field>
          <Field
            label="dashboard.eval.form.monthly_cap"
            hint="dashboard.eval.form.monthly_cap_hint"
          >
            <input
              inputMode="decimal"
              value={form.monthlyCapUsd}
              onInput={(e) => set({ monthlyCapUsd: e.currentTarget.value })}
            />
          </Field>
        </fieldset>

        <fieldset>
          <legend>{t('dashboard.eval.form.when')}</legend>
          {(['once', 'schedule', 'on_change'] as const).map((trigger) => (
            <label key={trigger} class="choice">
              <input
                type="radio"
                name="trigger"
                checked={form.trigger === trigger}
                onChange={() => set({ trigger })}
              />
              {t(TRIGGER_CHOICE_KEYS[trigger])}
            </label>
          ))}
          {form.trigger === 'schedule' && (
            <div class="row">
              <Field label="dashboard.eval.form.every">
                <select
                  value={form.every}
                  onChange={(e) =>
                    set({ every: e.currentTarget.value === 'daily' ? 'daily' : 'weekly' })
                  }
                >
                  <option value="daily">{t('dashboard.eval.form.daily')}</option>
                  <option value="weekly">{t('dashboard.eval.form.weekly')}</option>
                </select>
              </Field>
              {form.every === 'weekly' && (
                <Field label="dashboard.eval.form.weekday">
                  <select
                    value={form.weekday}
                    onChange={(e) => set({ weekday: e.currentTarget.value })}
                  >
                    {['1', '2', '3', '4', '5', '6', '7'].map((d) => (
                      <option key={d} value={d}>
                        {t(WEEKDAY_KEYS[d] ?? '')}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label="dashboard.eval.form.hour">
                <input
                  inputMode="numeric"
                  value={form.hour}
                  onInput={(e) => set({ hour: e.currentTarget.value })}
                />
              </Field>
            </div>
          )}
          {form.trigger !== 'once' && <p class="sub">{t('dashboard.eval.form.passkey_note')}</p>}
        </fieldset>

        <fieldset>
          <legend>{t('dashboard.eval.configurations')}</legend>
          {form.configurations.map((c, index) => (
            <div class="config-form" key={index}>
              <Field label="dashboard.eval.form.config_id">
                <input
                  value={c.id}
                  onInput={(e) => setConfig(index, { id: e.currentTarget.value })}
                />
              </Field>
              <Field label="dashboard.eval.form.source">
                <select
                  value={c.source}
                  onChange={(e) =>
                    setConfig(index, {
                      source: e.currentTarget.value === 'model' ? 'model' : 'agent',
                    })
                  }
                >
                  <option value="agent">{t('dashboard.eval.form.source_agent')}</option>
                  <option value="model">{t('dashboard.eval.form.source_model')}</option>
                </select>
              </Field>
              {c.source === 'agent' ? (
                <Field label="dashboard.eval.form.agent_key">
                  <input
                    value={c.agentKey}
                    onInput={(e) => setConfig(index, { agentKey: e.currentTarget.value })}
                  />
                </Field>
              ) : (
                <>
                  <Field label="dashboard.eval.form.model">
                    <input
                      value={c.model}
                      onInput={(e) => setConfig(index, { model: e.currentTarget.value })}
                    />
                  </Field>
                  <Field label="dashboard.eval.form.provider">
                    <select
                      value={c.providerType}
                      onChange={(e) =>
                        setConfig(index, {
                          providerType: e.currentTarget.value === 'api' ? 'api' : 'self_hosted',
                        })
                      }
                    >
                      <option value="self_hosted">{t('dashboard.eval.form.self_hosted')}</option>
                      <option value="api">{t('dashboard.eval.form.api')}</option>
                    </select>
                  </Field>
                </>
              )}
              <Field label="dashboard.eval.form.max_iterations">
                <input
                  inputMode="numeric"
                  value={c.maxIterations}
                  onInput={(e) => setConfig(index, { maxIterations: e.currentTarget.value })}
                />
              </Field>
              <Field label="dashboard.eval.form.max_minutes">
                <input
                  inputMode="numeric"
                  value={c.maxDurationMin}
                  onInput={(e) => setConfig(index, { maxDurationMin: e.currentTarget.value })}
                />
              </Field>
              <Field label="dashboard.eval.form.prompt_path" hint="dashboard.eval.form.prompt_hint">
                <input
                  value={c.promptPath}
                  placeholder="eval/prompts/short.md"
                  onInput={(e) => setConfig(index, { promptPath: e.currentTarget.value })}
                />
              </Field>
              {form.configurations.length > 1 && (
                <button
                  type="button"
                  class="button button-quiet"
                  onClick={() =>
                    setForm((f) => ({
                      ...f,
                      configurations: f.configurations.filter((_, i) => i !== index),
                    }))
                  }
                >
                  {t('dashboard.eval.form.remove_config')}
                </button>
              )}
            </div>
          ))}
          {form.configurations.length < MAX_CONFIGURATIONS && (
            <button
              type="button"
              class="button button-quiet"
              onClick={() =>
                setForm((f) => ({
                  ...f,
                  configurations: [...f.configurations, emptyConfig(f.configurations.length)],
                }))
              }
            >
              {t('dashboard.eval.form.add_config')}
            </button>
          )}
        </fieldset>

        <div class="toolbar">
          <button type="submit" class="button" disabled={busy}>
            {t(plan === null ? 'dashboard.eval.form.create' : 'dashboard.eval.form.save')}
          </button>
          <a
            class="button button-quiet"
            href={plan === null ? href('evaluations', { project }) : planHref(plan.id)}
          >
            {t('dashboard.eval.form.cancel')}
          </a>
        </div>
      </form>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: preact.ComponentChildren;
}) {
  return (
    <label class="field">
      <span class="field-label">{t(label)}</span>
      {children}
      {hint !== undefined && <span class="field-hint">{t(hint)}</span>}
    </label>
  );
}
