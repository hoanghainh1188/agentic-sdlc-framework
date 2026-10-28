// Escalation decision modal with passkey step-up (task U07, ADR-M73 §2.4).
import type { EscalationView } from '@sdlc/api-schemas';
import { cleanText } from '@sdlc/api-schemas';
import { useState } from 'preact/hooks';

import { ApiError } from '../api/client.js';
import { decideEscalation } from '../api/writes.js';
import { t } from '../i18n.js';
import { confirmEscalationWithPasskey, PasskeyCancelled } from '../views/step-up.js';

export interface EscalationModalProps {
  readonly escalation: EscalationView;
  readonly onClose: () => void;
  readonly onSuccess: () => void;
}

export function EscalationModal({ escalation, onClose, onSuccess }: EscalationModalProps) {
  const [decision, setDecision] = useState<'resume' | 'modify' | 'terminate' | 'escalate_further'>('resume');
  const [reasonCode, setReasonCode] = useState('');
  const [reasonRef, setReasonRef] = useState('');
  const [budgetIncrease, setBudgetIncrease] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleConfirm = async () => {
    setBusy(true);
    setErrorMsg(null);
    try {
      const decisionBody: Record<string, unknown> = {
        decision,
        ...(reasonCode ? { reason_code: reasonCode } : {}),
        ...(reasonRef ? { reason_ref: reasonRef } : {}),
        ...(budgetIncrease ? { budget_increase_usd: budgetIncrease } : {}),
      };

      const packetSha = typeof escalation.packet?.subject_sha256 === 'string'
        ? escalation.packet.subject_sha256
        : undefined;

      const stepUp = await confirmEscalationWithPasskey(
        escalation.code,
        packetSha,
        decisionBody,
      );

      await decideEscalation(escalation.code, {
        ...decisionBody,
        step_up: stepUp,
      });

      onSuccess();
    } catch (err: unknown) {
      if (err instanceof PasskeyCancelled) {
        setErrorMsg(t('dashboard.action.cancelled'));
      } else if (err instanceof ApiError && err.status === 409) {
        setErrorMsg(t('dashboard.action.conflict'));
      } else if (err instanceof ApiError) {
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
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div class="modal-card">
        <h3 id="modal-title">
          {t('dashboard.action.decide')} {cleanText(escalation.code)}
        </h3>

        <div class="field">
          <label for="escalation-decision">{t('dashboard.action.decision_label')}</label>
          <select
            id="escalation-decision"
            value={decision}
            onChange={(e) => {
              const val = e.currentTarget.value;
              if (val === 'resume' || val === 'modify' || val === 'terminate' || val === 'escalate_further') {
                setDecision(val);
              }
            }}
          >
            <option value="resume">{t('dashboard.action.decision_resume')}</option>
            <option value="modify">{t('dashboard.action.decision_modify')}</option>
            <option value="terminate">{t('dashboard.action.decision_terminate')}</option>
            <option value="escalate_further">{t('dashboard.action.decision_escalate')}</option>
          </select>
        </div>

        <div class="field">
          <label for="escalation-reason-code">{t('dashboard.action.reason_code')}</label>
          <input
            id="escalation-reason-code"
            type="text"
            placeholder="e.g. approved_exception"
            value={reasonCode}
            onInput={(e) => setReasonCode((e.target as HTMLInputElement).value)}
          />
        </div>

        <div class="field">
          <label for="escalation-reason-ref">{t('dashboard.action.reason_ref')}</label>
          <input
            id="escalation-reason-ref"
            type="url"
            placeholder="https://github.com/..."
            value={reasonRef}
            onInput={(e) => setReasonRef((e.target as HTMLInputElement).value)}
          />
        </div>

        <div class="field">
          <label for="escalation-budget">{t('dashboard.action.budget_increase')}</label>
          <input
            id="escalation-budget"
            type="text"
            placeholder="e.g. 5.00"
            value={budgetIncrease}
            onInput={(e) => setBudgetIncrease((e.target as HTMLInputElement).value)}
          />
        </div>

        {errorMsg && <p class="notice notice-error">{errorMsg}</p>}

        <div class="modal-buttons">
          <button type="button" class="button button-quiet" disabled={busy} onClick={onClose}>
            {t('dashboard.action.cancel')}
          </button>
          <button
            type="button"
            class="button button-primary"
            disabled={busy}
            onClick={() => {
              void handleConfirm();
            }}
          >
            {busy ? 'Verifying passkey…' : t('dashboard.action.confirm_passkey')}
          </button>
        </div>
      </div>
    </div>
  );
}
