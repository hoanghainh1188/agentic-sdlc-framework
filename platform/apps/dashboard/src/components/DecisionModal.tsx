// Gate decision confirmation modal with passkey step-up (task U07, ADR-M73 §2.4).
import type { IntentDetail as Detail } from '@sdlc/api-schemas';
import { cleanText } from '@sdlc/api-schemas';
import { useState } from 'preact/hooks';

import { ApiError } from '../api/client.js';
import { decideGate } from '../api/writes.js';
import { t } from '../i18n.js';
import { confirmGateDecisionWithPasskey, PasskeyCancelled } from '../views/step-up.js';

export interface DecisionModalProps {
  readonly intent: Detail;
  readonly gate: string;
  readonly mode: string;
  readonly decision: 'approve' | 'reject' | 'request_changes';
  readonly onClose: () => void;
  readonly onSuccess: () => void;
}

export function DecisionModal({
  intent,
  gate,
  mode,
  decision,
  onClose,
  onSuccess,
}: DecisionModalProps) {
  const [reasonCode, setReasonCode] = useState('');
  const [reasonRef, setReasonRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const titleKey =
    decision === 'approve'
      ? 'dashboard.action.approve'
      : decision === 'reject'
        ? 'dashboard.action.reject'
        : 'dashboard.action.request_changes';

  const needsReason = decision === 'reject' || decision === 'request_changes';

  const handleConfirm = async () => {
    setBusy(true);
    setErrorMsg(null);
    try {
      const decisionBody: Record<string, unknown> = {
        decision,
        ...(reasonCode ? { reason_code: reasonCode } : {}),
        ...(reasonRef ? { reason_ref: reasonRef } : {}),
      };

      const stepUp = await confirmGateDecisionWithPasskey(
        intent.code,
        gate,
        intent.gate_input_sha256 ?? null,
        decisionBody,
      );

      await decideGate(intent.code, gate, {
        ...decisionBody,
        ...(intent.gate_input_sha256 ? { expected_input_sha256: intent.gate_input_sha256 } : {}),
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
          {t(titleKey)} {cleanText(gate)} ({cleanText(mode)})
        </h3>

        <div class="binding-info">
          <div class="binding-row">
            <span>{t('dashboard.action.input_hash')}:</span>
            <span class="mono" title={intent.gate_input_sha256 ?? 'none'}>
              {intent.gate_input_sha256 ? `${intent.gate_input_sha256.slice(0, 16)}…` : 'none'}
            </span>
          </div>
          {intent.spec && (
            <div class="binding-row">
              <span>{t('dashboard.action.spec_hash')}:</span>
              <span class="mono" title={intent.spec.content_sha256}>
                {`${intent.spec.content_sha256.slice(0, 16)}…`}
              </span>
            </div>
          )}
          {intent.plan && (
            <div class="binding-row">
              <span>{t('dashboard.action.plan_hash')}:</span>
              <span class="mono" title={intent.plan.plan_sha256}>
                {`${intent.plan.plan_sha256.slice(0, 16)}…`}
              </span>
            </div>
          )}
        </div>

        {needsReason && (
          <>
            <div class="field">
              <label for="decision-reason-code">{t('dashboard.action.reason_code')}</label>
              <select
                id="decision-reason-code"
                value={reasonCode}
                onChange={(e) => setReasonCode((e.target as HTMLSelectElement).value)}
              >
                <option value="">{'-- select reason --'}</option>
                <option value="spec_unclear">{'spec_unclear'}</option>
                <option value="tests_insufficient">{'tests_insufficient'}</option>
                <option value="out_of_scope">{'out_of_scope'}</option>
                <option value="policy_denied">{'policy_denied'}</option>
                <option value="other">{t('dashboard.action.reason_other')}</option>
              </select>
            </div>
            <div class="field">
              <label for="decision-reason-ref">{t('dashboard.action.reason_ref')}</label>
              <input
                id="decision-reason-ref"
                type="url"
                placeholder="https://github.com/..."
                value={reasonRef}
                onInput={(e) => setReasonRef((e.target as HTMLInputElement).value)}
              />
            </div>
          </>
        )}

        {errorMsg && <p class="notice notice-error">{errorMsg}</p>}

        <div class="modal-buttons">
          <button type="button" class="button button-quiet" disabled={busy} onClick={onClose}>
            {t('dashboard.action.cancel')}
          </button>
          <button
            type="button"
            class={`button ${decision === 'reject' ? 'button-danger' : 'button-primary'}`}
            disabled={busy || (needsReason && !reasonCode)}
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
