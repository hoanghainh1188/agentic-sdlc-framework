// The U08 actions of one intent (design/ADR-M73 §2.1, MVP1-UI-SCOPE §3.3): submit the plan file
// and build an Evidence Pack, with no step-up; and the CLI command that saves an L1 run's
// proposal, which never downloads in the browser (ADR-M64). The page has no rule set: it shows
// the actions when dashboard actions are on and shows the API's refusal in the catalog's words.
// A success goes to the page (`onDone`), which shows it above the data it loads again.
import { useState } from 'preact/hooks';

import { buildEvidencePack, submitPlan } from '../api/writes.js';
import { t } from '../i18n.js';
import { commitField, proposalCommand } from '../model/intake.js';
import { intakeErrorText } from '../model/intake-text.js';

interface ActionProps {
  readonly intent: string;
  /** The success message; the page shows it and loads the intent again. */
  readonly onDone: (message: string) => void;
}

function Refusal({ text }: { readonly text: string | null }) {
  return text === null ? null : (
    <p class="notice notice-error" role="alert">
      {text}
    </p>
  );
}

/** Submit the plan file `.sdlc/plans/<INT-…>.yaml` as it is on the default branch. */
export function SubmitPlan({ intent, onDone }: ActionProps) {
  const [commit, setCommit] = useState('');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  const submit = async () => {
    const field = commitField(commit);
    if (!field.ok) {
      setRefused(t('dashboard.plan.error.commit'));
      return;
    }
    setBusy(true);
    setRefused(null);
    try {
      const plan = await submitPlan(intent, field.sha);
      onDone(t('dashboard.plan.submitted', { version: plan.version }));
    } catch (err: unknown) {
      setRefused(intakeErrorText(err, 'plan'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="intake-action" aria-labelledby="plan-submit-title">
      <h4 id="plan-submit-title">{t('dashboard.plan.submit_title')}</h4>
      <p class="muted small-value">{t('dashboard.plan.submit_help', { intent })}</p>
      <div class="intake-row">
        <label for="plan-commit">{t('dashboard.plan.commit')}</label>
        <input
          id="plan-commit"
          type="text"
          class="mono"
          maxLength={40}
          value={commit}
          onInput={(e) => setCommit(e.currentTarget.value)}
        />
        <button
          type="button"
          class="button button-primary button-small"
          disabled={busy}
          onClick={() => {
            void submit();
          }}
        >
          {busy ? t('dashboard.plan.submitting') : t('dashboard.plan.submit')}
        </button>
      </div>
      <Refusal text={refused} />
    </section>
  );
}

/** Build an Evidence Pack version; nothing changed returns the latest one. */
export function BuildPack({ intent, onDone }: ActionProps) {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  const build = async () => {
    setBusy(true);
    setRefused(null);
    try {
      const { pack, created } = await buildEvidencePack(intent);
      const key = created ? 'dashboard.pack.built' : 'dashboard.pack.unchanged';
      onDone(t(key, { version: pack.version }));
    } catch (err: unknown) {
      setRefused(intakeErrorText(err, 'pack'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="intake-action">
      <button
        type="button"
        class="button button-primary button-small"
        disabled={busy}
        onClick={() => {
          void build();
        }}
      >
        {busy ? t('dashboard.pack.building') : t('dashboard.pack.build')}
      </button>
      <Refusal text={refused} />
    </div>
  );
}

/** The command that saves the proposal of an L1 run (High risk): client code, file mode 600. */
export function ProposalCommand({ intent, runId }: { readonly intent: string; runId: string }) {
  return (
    <div class="proposal-command">
      <p>{t('dashboard.proposal.help')}</p>
      <pre class="mono">
        <code>{proposalCommand(intent, runId)}</code>
      </pre>
    </div>
  );
}
