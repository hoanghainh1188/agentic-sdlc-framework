// Create an intent from the dashboard, then link its spec (U08 AC1, design/ADR-M73 §2.1): the two
// calls of `adlc intent create --spec` (U03), with no step-up. A refused link keeps the intent and
// says so; the person links the spec again with `adlc spec link`. Who may create and link comes
// from the project's `access.*` roles: the page has no rule set and shows the API's refusal.
import type { IntentView } from '@sdlc/api-schemas';
import { useState } from 'preact/hooks';

import {
  createIntent,
  linkSpec,
  type CreateIntentInput,
  type LinkSpecInput,
} from '../api/writes.js';
import { t } from '../i18n.js';
import { commitField } from '../model/intake.js';
import { intakeErrorText } from '../model/intake-text.js';

export interface CreateIntentModalProps {
  readonly projects: readonly string[];
  readonly defaultProject?: string;
  readonly onClose: () => void;
  readonly onSuccess: (intent: IntentView) => void;
}

const RISK_TIERS = ['low', 'medium', 'high', 'critical'] as const;
const DATA_CLASSES = ['public', 'internal', 'confidential', 'restricted'] as const;
const SPEC_TOOLS = ['manual', 'spec-kit', 'bmad'] as const;
const BUDGET = /^\d{1,12}(\.\d{1,6})?$/;

const pick = <T extends string>(values: readonly T[], value: string): T | undefined =>
  values.find((v) => v === value);

/** The intent was created, its spec was not linked: the intent stays, the page says why. */
interface LinkRefused {
  readonly intent: IntentView;
  readonly text: string;
}

export function CreateIntentModal({
  projects,
  defaultProject,
  onClose,
  onSuccess,
}: CreateIntentModalProps) {
  const [project, setProject] = useState(defaultProject ?? projects[0] ?? '');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [riskTier, setRiskTier] = useState<CreateIntentInput['risk_tier']>('low');
  const [dataClass, setDataClass] = useState<CreateIntentInput['data_class']>('internal');
  const [budgetUsd, setBudgetUsd] = useState('');
  const [issueNumber, setIssueNumber] = useState('');
  const [specPath, setSpecPath] = useState('');
  const [specCommit, setSpecCommit] = useState('');
  const [specTool, setSpecTool] = useState<(typeof SPEC_TOOLS)[number]>('manual');
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [linkRefused, setLinkRefused] = useState<LinkRefused | null>(null);

  /** The request bodies, or the catalog key of the first field that is wrong. */
  const bodies = ():
    | { readonly intent: CreateIntentInput; readonly spec?: LinkSpecInput }
    | { readonly error: string } => {
    if (!project) return { error: 'dashboard.intent.error.project' };
    if (!title.trim()) return { error: 'dashboard.intent.error.title' };
    const budget = budgetUsd.trim();
    if (budget !== '' && !BUDGET.test(budget)) return { error: 'dashboard.intent.error.budget' };
    const issue = issueNumber.trim();
    if (issue !== '' && !/^[1-9]\d{0,9}$/.test(issue)) {
      return { error: 'dashboard.intent.error.issue' };
    }
    const commit = commitField(specCommit);
    if (!commit.ok) return { error: 'dashboard.intent.error.spec_commit' };
    const path = specPath.trim();
    if (path === '' && commit.sha !== undefined) {
      return { error: 'dashboard.intent.error.spec_path' };
    }
    const intent: CreateIntentInput = {
      project,
      title: title.trim(),
      description: description.trim(),
      risk_tier: riskTier,
      data_class: dataClass,
      ...(budget === '' ? {} : { budget_usd: budget }),
      ...(issue === '' ? {} : { issue_number: Number(issue) }),
    };
    if (path === '') return { intent };
    return {
      intent,
      spec: {
        path,
        source_tool: specTool,
        ...(commit.sha === undefined ? {} : { commit_sha: commit.sha }),
      },
    };
  };

  const handleSubmit = async () => {
    const request = bodies();
    if ('error' in request) {
      setErrorMsg(t(request.error));
      return;
    }
    setBusy(true);
    setErrorMsg(null);
    let created: IntentView;
    try {
      created = await createIntent(request.intent);
    } catch (err: unknown) {
      setErrorMsg(intakeErrorText(err, 'create'));
      setBusy(false);
      return;
    }
    if (request.spec === undefined) {
      onSuccess(created);
      return;
    }
    try {
      await linkSpec(created.code, request.spec);
      onSuccess(created);
    } catch (err: unknown) {
      setLinkRefused({ intent: created, text: intakeErrorText(err, 'spec') });
      setBusy(false);
    }
  };

  if (linkRefused !== null) {
    return (
      <div
        class="modal-backdrop"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-intent-title"
      >
        <div class="modal-card">
          <h3 id="create-intent-title">{t('dashboard.intent.spec_refused_title')}</h3>
          <p role="status">
            {t('dashboard.intent.spec_refused', { intent: linkRefused.intent.code })}
          </p>
          <p class="notice notice-error" role="alert">
            {linkRefused.text}
          </p>
          <p class="muted">
            {t('dashboard.intent.spec_refused_next', { intent: linkRefused.intent.code })}
          </p>
          <div class="modal-buttons">
            <button
              type="button"
              class="button button-primary"
              onClick={() => onSuccess(linkRefused.intent)}
            >
              {t('dashboard.intent.open')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      class="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-intent-title"
    >
      <div class="modal-card modal-card-scroll">
        <h3 id="create-intent-title">{t('dashboard.intent.create_title')}</h3>

        <div class="field">
          <label for="intent-project">{t('dashboard.intent.project')}</label>
          <select
            id="intent-project"
            value={project}
            onChange={(e) => setProject(e.currentTarget.value)}
          >
            {projects.map((slug) => (
              <option key={slug} value={slug}>
                {slug}
              </option>
            ))}
          </select>
        </div>

        <div class="field">
          <label for="intent-title">{t('dashboard.intent.title_field')}</label>
          <input
            id="intent-title"
            type="text"
            required
            maxLength={200}
            value={title}
            onInput={(e) => setTitle(e.currentTarget.value)}
          />
        </div>

        <div class="field">
          <label for="intent-desc">{t('dashboard.intent.desc_field')}</label>
          <textarea
            id="intent-desc"
            rows={4}
            maxLength={10000}
            value={description}
            onInput={(e) => setDescription(e.currentTarget.value)}
            placeholder={t('dashboard.intent.desc_placeholder')}
          />
        </div>

        <div class="field-row">
          <div class="field">
            <label for="intent-risk">{t('dashboard.intent.risk_field')}</label>
            <select
              id="intent-risk"
              value={riskTier}
              onChange={(e) => {
                const value = pick(RISK_TIERS, e.currentTarget.value);
                if (value) setRiskTier(value);
              }}
            >
              {RISK_TIERS.map((tier) => (
                <option key={tier} value={tier}>
                  {tier}
                </option>
              ))}
            </select>
          </div>

          <div class="field">
            <label for="intent-data-class">{t('dashboard.intent.data_class_field')}</label>
            <select
              id="intent-data-class"
              value={dataClass}
              onChange={(e) => {
                const value = pick(DATA_CLASSES, e.currentTarget.value);
                if (value) setDataClass(value);
              }}
            >
              {DATA_CLASSES.map((dc) => (
                <option key={dc} value={dc}>
                  {dc}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div class="field-row">
          <div class="field">
            <label for="intent-budget">{t('dashboard.intent.budget_field')}</label>
            <input
              id="intent-budget"
              type="text"
              inputMode="decimal"
              value={budgetUsd}
              onInput={(e) => setBudgetUsd(e.currentTarget.value)}
            />
          </div>

          <div class="field">
            <label for="intent-issue">{t('dashboard.intent.issue_field')}</label>
            <input
              id="intent-issue"
              type="text"
              inputMode="numeric"
              value={issueNumber}
              onInput={(e) => setIssueNumber(e.currentTarget.value)}
            />
          </div>
        </div>

        <fieldset class="modal-fieldset">
          <legend>{t('dashboard.intent.spec_legend')}</legend>
          <p class="muted small-value">{t('dashboard.intent.spec_help')}</p>
          <div class="field">
            <label for="intent-spec-path">{t('dashboard.intent.spec_path')}</label>
            <input
              id="intent-spec-path"
              type="text"
              maxLength={1024}
              value={specPath}
              onInput={(e) => setSpecPath(e.currentTarget.value)}
            />
          </div>
          <div class="field-row">
            <div class="field">
              <label for="intent-spec-commit">{t('dashboard.intent.spec_commit')}</label>
              <input
                id="intent-spec-commit"
                type="text"
                maxLength={40}
                class="mono"
                value={specCommit}
                onInput={(e) => setSpecCommit(e.currentTarget.value)}
              />
            </div>
            <div class="field">
              <label for="intent-spec-tool">{t('dashboard.intent.spec_tool')}</label>
              <select
                id="intent-spec-tool"
                value={specTool}
                onChange={(e) => {
                  const value = pick(SPEC_TOOLS, e.currentTarget.value);
                  if (value) setSpecTool(value);
                }}
              >
                {SPEC_TOOLS.map((tool) => (
                  <option key={tool} value={tool}>
                    {tool}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </fieldset>

        {errorMsg && (
          <p class="notice notice-error" role="alert">
            {errorMsg}
          </p>
        )}

        <div class="modal-buttons">
          <button type="button" class="button button-quiet" disabled={busy} onClick={onClose}>
            {t('dashboard.action.cancel')}
          </button>
          <button
            type="button"
            class="button button-primary"
            disabled={busy || !title.trim()}
            onClick={() => {
              void handleSubmit();
            }}
          >
            {busy ? t('dashboard.intent.creating') : t('dashboard.intent.submit')}
          </button>
        </div>
      </div>
    </div>
  );
}
