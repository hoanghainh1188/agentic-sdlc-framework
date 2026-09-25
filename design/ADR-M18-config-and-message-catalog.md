# ADR-M18. Project configuration package and message catalog

| Item | Value |
|---|---|
| Status | **Proposed** (task A05, PR for review) |
| Date | 2026-09-25 |
| Decided by | Harry (plan approved 2026-09-25) |
| Related | D-08 task A05; D-02 FR-14…FR-18, NFR-04, NFR-08; D-03 sections 6.1, 6.4, 7.3, 11, ADR-M13; D-05 sections 5, 6.1, 10; D-07 section 6; ADR-M16; codes table §3, §4, §6.3; design/QUESTIONS.md #5–#10 |

## 1. Context

Task A05 reads the per-project configuration: the gate × risk oversight matrix, SLA table, change-flag lists, retry counts, budgets, loop limits, evidence retention and policy rules. The platform must refuse configurations that loosen mandatory handbook rules. The error messages must come from a message catalog (NFR-08), and no catalog existed yet. `config_hash` must be stable for the same content.

## 2. Decision

### 2.1. Libraries

| Need | Choice | Version | Licence |
|---|---|---|---|
| YAML parser | `yaml` (eemeli) | 2.9.1 | ISC |
| Schema validation | `zod` | 4.6.5 | MIT |
| RFC 8785 canonical JSON | Our own module (`@sdlc/config` `canonicalJson`, about 40 lines) | — | — |

- Neither library has runtime dependencies. Both licences allow commercial use and redistribution (NFR-04).
- `canonicalize` (Apache-2.0, by an author of RFC 8785) is ESM-only since version 5. Our packages are CommonJS (ADR-M16 §2.2). The input is plain JSON data, so JCS reduces to sorted keys plus ECMAScript `JSON.stringify` for strings and numbers. The module is tested against the RFC 8785 examples. The audit hash chain (A07) reuses it.
- YAML is read with the YAML 1.2 **core** schema: no custom tags, no YAML 1.1 tags (`!!timestamp`, `!!binary`), no merge keys. Duplicate keys are errors. Alias expansion is capped at 100. Any YAML warning is an error. A `__proto__` key stays an ordinary (unknown, refused) setting; it never changes an object prototype.
- Error text never comes from zod. Zod issues are mapped to catalog keys.

### 2.2. Where the code lives

| Package | Content |
|---|---|
| `@sdlc/contracts` | Canonical code lists from D-05 §5 (`GATE_CODES`, `RISK_TIERS`, …) and the `ProjectConfig` types. **Types and code lists only.** |
| `@sdlc/config` | Default file, YAML reading, merge, schema, mandatory rules, warnings, `config_hash`, working-time calendar |
| `@sdlc/messages` (new) | Message catalog |

- The policy adapter (B01) may import `@sdlc/contracts` only (ADR-M16 §2.5). So the config **types** are in contracts, and the app passes the loaded config object to the adapter.
- `loadProjectConfig` and `defaultProjectConfig` return a branded `ValidatedProjectConfig` (declared in contracts). Only `@sdlc/config` creates it, after the schema and M1–M15 pass. The policy adapter accepts only this type, so it never sees an unchecked configuration and never repeats the checks (B01).
- `@sdlc/messages` is a new package that is not listed in D-03 §11. Core, config and apps import it. Adapters do not: they receive rendered text from core or the apps.

### 2.3. Configuration model

- The default file `platform/packages/config/defaults/project-config.default.yaml` holds the codes table values. Each value cites its source. Values that no document gives are marked `[Proposal] pilot default, review after 2–4 weeks of data (handbook Ch.8)` (QUESTIONS.md #9).
- A project's YAML is a **partial override**. Mappings merge key by key. Lists, scalars, durations (`{ value, unit }`) and deadlines (`{ kind }`) replace the default value whole.
- **Reserved key names:** the merge treats *any* mapping that has a `unit` or a `kind` key as a single value (a duration or deadline) and replaces it whole. Future configuration sections must not use `unit` or `kind` as key names in ordinary mappings, or those mappings will stop merging key by key.
- Matrix cell: `mode` (HITL, HOTL, AUDIT, or `POLICY` = automatic policy check, G4 only; QUESTIONS.md #6), `roles`, `approvals`, and optional `on_breach` (must be HITL).
- The working calendar (time zone, working days, working hours, `holidays`) drives the working-hour and working-day clocks. One working day = the length of the working hours. Holidays (for example Tết) are skipped.

### 2.4. Mandatory rules (floors in code)

- Rules M1–M15 are in `platform/packages/config/src/mandatory-rules.ts`, each with its source. They cover G1, G7 and production G8 HITL; the forced-HITL G3 and dual-approval G7 lists; G6 security findings; autonomy; model routing; budget thresholds; the loop limit; SLA clocks; cell structure. They also cover the three things the codes table says are never skipped (M13–M15).
- M6 also covers the G6 security threshold `oversight.g6_security_findings.min_severity` (default `high`): the threshold must always include critical findings. Raising the threshold (for example to `critical`) is a warning (design/QUESTIONS.md #19, B01).
- The floors are in code on purpose, so that configuration cannot loosen them. Changing a floor needs an approved handbook change, then the design doc, then a backlog task.
- Other loosening (for example G2 Medium HITL → HOTL) is allowed but returned as a **warning**. Callers write it to the `config.changed` audit event (ADR-M13).
- **Calendar floor (part of M11, Harry, 2026-09-25):** M11 compares SLA clocks in the project's own calendar, so a shrunken calendar would stretch "1 working day" in real time. The calendar must therefore have **at least 5 working days per week and at least 7 working hours per day**; below that the configuration is refused (codes table §6.3).
- Calendar changes above the floor that still make working-time clocks run longer (a working day swapped out, shorter working hours) are warnings. **More than 20 holidays in one calendar year** is also a warning. Adding working days, a longer working day, or up to 20 holidays a year gives no warning.
- A drift test compares the default file with codes table §3, §4 and §6.3 and with handbook Ch.6 §6.4. A codes-table change must come with the matching default-config change in the same PR.

### 2.5. `config_hash`

`config_hash = SHA-256(RFC 8785 canonical JSON of the effective configuration)`, where the effective configuration is the defaults merged with the override, then validated. Comments, whitespace, key order, quoting and values that only repeat a default do not change it. Design/D-05 §6.1 was updated to match (QUESTIONS.md #8).

### 2.6. Message catalog

- One JSON file per locale: `platform/packages/messages/src/locales/<locale>.json`. English (`en`) is the source.
- Keys are flat and dotted (`config.rule.g1_hitl`). Placeholders use the ICU `{name}` form, so we can move to full ICU MessageFormat (for example `intl-messageformat`, BSD-3-Clause) later without rewriting the catalogs.
- API: `t(key, params, locale = 'en')`. The key type comes from `en.json`. A missing key or an unknown locale falls back to English.
- Adding Vietnamese or Japanese: add `vi.json` or `ja.json` and register it in `CATALOGS`. A test checks that every locale has the same keys and placeholders as English. Another test checks that every English key is used in code.
- Code returns issues as `{ key, path, params }`; text is rendered only at the edge (`formatIssue`).

## 3. Alternatives not chosen

| Option | Why not |
|---|---|
| ajv + JSON Schema | Weaker TypeScript types; the schema and types would drift apart |
| valibot | Fine, but no advantage over zod for this use |
| `canonicalize` package | ESM-only; our packages are CommonJS |
| Hash of the raw YAML text (D-05 wording before this ADR) | Comments or formatting would change the hash |
| Floors in configuration | A configuration change could then loosen a mandatory rule |
| Catalog inside `@sdlc/contracts` | Contracts holds types only (Harry, 2026-09-25) |
| i18next, full ICU now | More than needed today; the `{name}` format keeps the path open |

## 4. Consequences

- New workspace package `@sdlc/messages`; the root `tsconfig.json` and the workspace structure test list it.
- `pnpm test` runs tests against package sources through Vitest aliases. `pnpm typecheck` checks the same imports against the built types.
- B01 (policy), B07 (workflow), B11 (escalation clocks) and C07 (budget) read their values from the loaded configuration, never from constants.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-09-25 | Claude (task A05) | First version |
| 0.2 | 2026-09-25 | Claude (task A05) | Review of PR #53: calendar floor in M11 (5 days, 7 hours), holiday warning (> 20 a year), reserved `unit` / `kind` keys |
| 0.3 | 2026-09-25 | Claude (task B01) | §2.2: `ValidatedProjectConfig` brand; §2.4: G6 security threshold in M6 and its warning (QUESTIONS.md #19) |
