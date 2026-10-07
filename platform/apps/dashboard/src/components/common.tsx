// Small shared pieces: durations, due clocks, state messages, the gate track and the bar.
import { cleanText } from '@sdlc/api-schemas';
import type { ComponentChildren } from 'preact';

import { ApiError } from '../api/client.js';
export { codeClass } from './class-name.js';
import type { Loaded } from '../api/use-api.js';
import { LOCALE, t } from '../i18n.js';
import { gateTrack } from '../model/intents.js';
import { dueState, durationLabel } from '../model/time.js';

/** Server text, cleaned of control and bidi characters; Preact renders it as text, never HTML. */
export function Txt({ value }: { readonly value: string | null | undefined }) {
  return <>{value === null || value === undefined || value === '' ? '—' : cleanText(value)}</>;
}

export function Duration({ seconds }: { readonly seconds: number | null }) {
  if (seconds === null) return <span class="muted">—</span>;
  const label = durationLabel(seconds);
  return <span class="num">{t(label.key, label.params)}</span>;
}

const dateTime = new Intl.DateTimeFormat(LOCALE, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
});

export function When({ iso }: { readonly iso: string | null }) {
  if (iso === null) return <span class="muted">—</span>;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? (
    <span class="muted">—</span>
  ) : (
    <time dateTime={iso}>{dateTime.format(at)}</time>
  );
}

/** A due clock: "in 2h 10m", "4h 3m overdue", with its state for colour. */
export function Due({ iso, now }: { readonly iso: string | null; readonly now: Date }) {
  const { state, seconds } = dueState(iso, now);
  if (state === 'none') return <span class="muted">{t('dashboard.due.none')}</span>;
  const label = durationLabel(seconds);
  const text = t(label.key, label.params);
  return (
    <span class={`due due-${state}`}>
      {state === 'overdue'
        ? t('dashboard.due.overdue', { duration: text })
        : t('dashboard.due.in', { duration: text })}
    </span>
  );
}

export function ErrorMessage({ error }: { readonly error: ApiError }) {
  const key =
    error.status === 401
      ? 'dashboard.error.unauthorized'
      : error.status === 403
        ? 'dashboard.error.forbidden'
        : error.status === 404
          ? 'dashboard.error.not_found'
          : error.status === 503
            ? 'dashboard.error.unavailable'
            : error.status === 0 && error.code === 'network'
              ? 'dashboard.error.network'
              : error.code === 'invalid_response'
                ? 'dashboard.error.invalid_response'
                : 'dashboard.error.unexpected';
  return (
    <p class="notice notice-error" role="alert">
      {t(key, { code: cleanText(error.code) })}
    </p>
  );
}

/** Loading, error, or the content. */
export function Show<T>({
  loaded,
  children,
}: {
  readonly loaded: Loaded<T>;
  readonly children: (data: T, at: Date) => ComponentChildren;
}) {
  if (loaded.state === 'loading') {
    return (
      <p class="notice" role="status" aria-live="polite">
        {t('dashboard.state.loading')}
      </p>
    );
  }
  if (loaded.state === 'error') return <ErrorMessage error={loaded.error} />;
  return <>{children(loaded.data, loaded.at)}</>;
}

export function Empty({ messageKey }: { readonly messageKey: string }) {
  return <p class="notice notice-empty">{t(messageKey)}</p>;
}

const TRACK_STATE_KEYS = {
  passed: 'dashboard.track.passed',
  current: 'dashboard.track.current',
  ahead: 'dashboard.track.ahead',
} as const;

/** A catalog label, or a server code shown as cleaned text when the dashboard has no label. */
export function Label({
  value,
}: {
  readonly value: { readonly key: string } | { readonly code: string };
}) {
  return 'key' in value ? <>{t(value.key)}</> : <Txt value={value.code} />;
}

/** G1–G8 as eight steps; the current gate is marked, the passed ones filled. */
export function GateTrack({
  intent,
}: {
  readonly intent: { readonly current_gate: string | null; readonly status: string };
}) {
  return (
    <ol class="track" aria-label={t('dashboard.track.label')}>
      {gateTrack(intent).map(({ gate, state }) => (
        <li
          key={gate}
          class={`track-step track-${state}`}
          aria-current={state === 'current' ? 'step' : undefined}
        >
          <span class="track-code">{gate}</span>
          <span class="visually-hidden">{t(TRACK_STATE_KEYS[state])}</span>
        </li>
      ))}
    </ol>
  );
}

/** A horizontal bar (SVG, no inline style): `value` from 0 to 1. */
export function Bar({
  value,
  tone = 'ink',
  marker,
  label,
}: {
  readonly value: number;
  readonly tone?: 'ink' | 'accent' | 'warn' | 'alert';
  readonly marker?: number | undefined;
  readonly label: string;
}) {
  const width = Math.round(Math.min(1, Math.max(0, value)) * 1000) / 10;
  return (
    <svg class="bar" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label={label}>
      <rect class="bar-track" x="0" y="0" width="100" height="8" rx="1" />
      <rect class={`bar-fill bar-${tone}`} x="0" y="0" width={width} height="8" rx="1" />
      {marker !== undefined && (
        <rect
          class="bar-marker"
          x={Math.min(99.4, Math.max(0, marker * 100))}
          y="0"
          width="0.6"
          height="8"
        />
      )}
    </svg>
  );
}
