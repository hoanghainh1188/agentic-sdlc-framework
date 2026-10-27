# ADR-M96. Dependencies an agent adds: licence, install scripts, typosquatting and vulnerability checks

| Item | Value |
|---|---|
| Status | **Accepted** (Harry, 2026-10-27, in the H02 plan; QUESTIONS #606–#608) |
| Date | 2026-10-27 |
| Decided by | Harry (H02 plan approved on 2026-10-27) |
| Related | D-08 H02 AC1–AC5; D-02 FR-33, NFR-04; D-03 §6 (G6); D-05 §5, §6.4; ADR-M80 §5 gaps G-1 (install scripts, Medium) and G-5 (shared proxy cache, Low); ADR-M93 (secret scan); ADR-M95 (review size); QUESTIONS #440, #606–#608 |

## 1. Context

AI coding agents can add or modify third-party dependencies during a run. In ADR-M80 (H01 Threat Model), two specific gaps were identified:
- **Gap G-1 (Medium)**: The package proxy allows any package from npmjs, and npm install scripts (`preinstall`, `install`, `postinstall`) execute inside the sandbox. Even though the sandbox has no outbound internet access and no secrets, install scripts could contain malicious code or attempt side-channel attacks.
- **Gap G-5 (Low)**: The package proxy (Verdaccio) caches downloaded packages across all runs and tenants, creating a shared cache that could be vulnerable to cache poisoning.
- Furthermore, an agent may introduce libraries with incompatible commercial licenses (e.g. AGPL/GPL in a proprietary project), packages with known critical CVEs, or typosquatted packages (e.g. `lodsh` instead of `lodash`).

Today, G6 relies solely on the target project's CI. A project without automated dependency scanning would allow unvetted dependencies into pull requests unchecked (QUESTIONS #440).

## 2. Decision

### 2.1. Detection outside the sandbox (AC1)

The runner checks dependencies in `apps/runner/src/workspace/dependencies.ts`, called during `storeChanges` (`changes.ts`) outside the sandbox:
1. Inspects the modified files in the staged patch for package manifests and lockfiles:
   - `package.json`
   - `package-lock.json`
   - `pnpm-lock.yaml`
   - `yarn.lock`
2. Compares dependencies at `base_sha` and `HEAD` to extract added and upgraded packages.
3. If no dependency manifests or lockfiles changed, the scan returns `clean` immediately with zero counts.

### 2.2. Multi-tier checks (AC2, AC4)

For each added or modified package:
1. **Allowed licenses**: Checked against `dependencies.allowed_licenses` from project configuration (default: permissive commercial licenses `MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, `0BSD`, `CC0-1.0`). Any unapproved or missing license is flagged.
2. **Install scripts (G-1)**: Manifests and lockfiles are inspected for lifecycle hooks (`preinstall`, `install`, `postinstall`). New packages with install scripts are recorded as findings.
3. **Typosquatting**: Package names are compared against a curated dictionary of popular packages using Levenshtein distance (distance 1, or 2 for names longer than 5 chars). Suspicious look-alikes trigger a typosquatting warning.
4. **Blocked & Vulnerable packages**: Blocked package names in `dependencies.blocked_packages` or known vulnerability flags trigger a critical finding.

### 2.3. Run event `dependencies_scanned` (AC2)

The check records counts and codes only, never package text, commands, or secrets (R030, R031):

| Field | Type | Description |
|---|---|---|
| `result` | string | `clean`, `warning`, `finding`, or `failed` |
| `new_dependencies` | number | Count of added packages |
| `changed_dependencies` | number | Count of upgraded/changed packages |
| `license_violations` | number | Count of packages with unapproved licenses |
| `install_scripts` | number | Count of new packages with install scripts |
| `typosquatting_warnings` | number | Count of potential typosquatting packages |
| `advisory_findings` | number | Count of blocked or known vulnerable packages |
| `cause` | string | Optional error code if scan failed (`parse_failed`, `manifest_unreadable`) |

The event is recorded in `run_events` in the same transaction as `diff_stored`, `changes_checked`, `secrets_scanned`, and `diff_measured`.

### 2.4. Quality Gate G6 Oversight (AC3)

At Gate G6 (`platform/packages/core/src/workflow/g6-verify.ts`):
1. **Critical finding** (`advisory_findings > 0`): The run stops, and the intent pauses at G6 with a `security` escalation (`security_finding`), requiring operator/governance triage.
2. **Non-critical finding** (`license_violations > 0` or `install_scripts > 0` or `typosquatting_warnings > 0`): G6 oversight mode is forced to **HITL** with reason `dependency_finding`. Person B must explicitly review and approve the dependency changes before merging.
3. **Failed scan** (`result === 'failed'`): G6 is forced to **HITL** with reason `dependency_scan_failed` (fail-closed principle).
4. **Clean**: Normal matrix oversight rules apply.

### 2.5. Package Proxy Cache Isolation (AC4)

In `platform/deploy/verdaccio/config.yaml`:
The uplink `npmjs` has `cache: false`. Verdaccio operates as a pass-through egress proxy for the sandbox without persisting a shared cache volume across tenants and runs, closing ADR-M80 gap G-5.
