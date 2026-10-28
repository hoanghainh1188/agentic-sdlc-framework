// Modal for creating a new intent directly from the dashboard (task U08, ADR-M73).
import { useState } from 'preact/hooks';
import type { IntentView } from '@sdlc/api-schemas';

import { ApiError } from '../api/client.js';
import { createIntent, type CreateIntentInput } from '../api/writes.js';
import { t } from '../i18n.js';

export interface CreateIntentModalProps {
  readonly projects: readonly string[];
  readonly defaultProject?: string;
  readonly onClose: () => void;
  readonly onSuccess: (intent: IntentView) => void;
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
  const [budgetUsd, setBudgetUsd] = useState('5.0');
  const [issueNumber, setIssueNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!project) {
      setErrorMsg('Please select a project');
      return;
    }
    if (!title.trim()) {
      setErrorMsg('Please enter a title');
      return;
    }

    setBusy(true);
    setErrorMsg(null);
    try {
      const created = await createIntent({
        project,
        title: title.trim(),
        description: description.trim(),
        risk_tier: riskTier,
        data_class: dataClass,
        budget_usd: budgetUsd.trim() ? budgetUsd.trim() : undefined,
        issue_number: issueNumber.trim() ? Number(issueNumber.trim()) : undefined,
      });
      onSuccess(created);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMsg(err.reason ? `${err.code}: ${err.reason}` : err.code);
      } else if (err instanceof Error) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg('An unexpected error occurred.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="create-intent-title">
      <div class="modal-card">
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
            placeholder="e.g. Add Japanese labels to the product list"
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
            placeholder="Objectives, scope or markdown specification..."
          />
        </div>

        <div class="field-row">
          <div class="field">
            <label for="intent-risk">{t('dashboard.intent.risk_field')}</label>
            <select
              id="intent-risk"
              value={riskTier}
              onChange={(e) => {
                const val = e.currentTarget.value;
                if (val === 'low' || val === 'medium' || val === 'high' || val === 'critical') {
                  setRiskTier(val);
                }
              }}
            >
              <option value="low">{'low'}</option>
              <option value="medium">{'medium'}</option>
              <option value="high">{'high'}</option>
              <option value="critical">{'critical'}</option>
            </select>
          </div>

          <div class="field">
            <label for="intent-data-class">{t('dashboard.intent.data_class_field')}</label>
            <select
              id="intent-data-class"
              value={dataClass}
              onChange={(e) => {
                const val = e.currentTarget.value;
                if (val === 'public' || val === 'internal' || val === 'confidential' || val === 'restricted') {
                  setDataClass(val);
                }
              }}
            >
              <option value="public">{'public'}</option>
              <option value="internal">{'internal'}</option>
              <option value="confidential">{'confidential'}</option>
              <option value="restricted">{'restricted'}</option>
            </select>
          </div>
        </div>

        <div class="field-row">
          <div class="field">
            <label for="intent-budget">{t('dashboard.intent.budget_field')}</label>
            <input
              id="intent-budget"
              type="text"
              value={budgetUsd}
              onInput={(e) => setBudgetUsd(e.currentTarget.value)}
              placeholder="5.0"
            />
          </div>

          <div class="field">
            <label for="intent-issue">{t('dashboard.intent.issue_field')}</label>
            <input
              id="intent-issue"
              type="number"
              min={1}
              value={issueNumber}
              onInput={(e) => setIssueNumber(e.currentTarget.value)}
              placeholder="123"
            />
          </div>
        </div>

        {errorMsg && <p class="notice notice-error">{errorMsg}</p>}

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
