// The project filter: the projects the person has a role on (from GET /v1/me).
import type { Me } from '@sdlc/api-schemas';

import { Txt } from '../components/common.js';
import { t } from '../i18n.js';

export function projectsOf(me: Me): string[] {
  return [
    ...new Set(me.roles.flatMap((r) => (r.project.slug === null ? [] : [r.project.slug]))),
  ].sort();
}

export function ProjectFilter({
  projects,
  value,
  onChange,
  allLabelKey = 'dashboard.filter.all_projects',
}: {
  readonly projects: readonly string[];
  readonly value: string | undefined;
  readonly onChange: (slug: string | undefined) => void;
  readonly allLabelKey?: string;
}) {
  return (
    <label class="select">
      <span class="select-label">{t('dashboard.filter.project')}</span>
      <select value={value ?? ''} onChange={(e) => onChange(e.currentTarget.value || undefined)}>
        <option value="">{t(allLabelKey)}</option>
        {projects.map((slug) => (
          <option key={slug} value={slug}>
            <Txt value={slug} />
          </option>
        ))}
      </select>
    </label>
  );
}
