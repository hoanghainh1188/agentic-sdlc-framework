// The U08 writes of the stub API (design/ADR-M73 §2.1): create an intent, link its spec, submit
// the plan file, build an Evidence Pack, fictional and in memory. None needs a step-up. The demo
// person is Person A in `shop` and Person B in `pilot` (fixtures `ME`), so the stub refuses as the
// API's default `access.*` roles do: only Person A creates, links a spec and submits a plan
// (`forbidden`); both build a pack. The refusals carry the API's code and reason. Nothing here is
// real data.
import { intentOf, packOf } from './fixtures.mjs';

const NOW = () => new Date().toISOString();
const USER = '00000000-0000-4000-8000-000000000001';

const CREATE = /^\/v1\/intents$/;
const SPEC = /^\/v1\/intents\/(INT-2026-[0-9]{4})\/specs$/;
const PLAN = /^\/v1\/intents\/(INT-2026-[0-9]{4})\/plans$/;
const PACK = /^\/v1\/intents\/(INT-2026-[0-9]{4})\/evidence-packs$/;

/** The intent the stub "creates" in `shop`: the draft the fixtures already show. */
const CREATED = 'INT-2026-0009';
/** A spec path the Git host does not have. */
const MISSING_SPEC = 'docs/specs/missing.md';
/** A commit whose plan file differs from the default branch. */
const OLD_COMMIT = 'f'.repeat(40);
/** The intent whose Evidence Pack has not changed since version 1. */
const UNCHANGED = 'INT-2026-0006';

const refusal = (status, code, reason) => ({
  status,
  body: { error: { code, message: code, ...(reason ? { reason } : {}) } },
});

const personA = (intent) => intent?.project.slug === 'shop';

export function isIntakePath(pathname) {
  return [CREATE, SPEC, PLAN, PACK].some((p) => p.test(pathname));
}

/** The answer of a U08 write. */
export function intakeWrite(url, body) {
  if (CREATE.test(url.pathname)) {
    if (typeof body.title !== 'string' || body.title.trim() === '' || 'body' in body) {
      return refusal(400, 'invalid_request');
    }
    if (body.project !== 'shop') return refusal(403, 'forbidden');
    return { status: 201, body: { ...intentOf(CREATED), title: body.title } };
  }
  const spec = SPEC.exec(url.pathname);
  if (spec) {
    const intent = intentOf(spec[1]);
    if (!intent) return refusal(404, 'intent_not_found');
    if (!personA(intent)) return refusal(403, 'forbidden');
    if (body.path === MISSING_SPEC) return refusal(422, 'spec_invalid', 'missing');
    return {
      status: 201,
      body: {
        intent: intent.code,
        version: 1,
        path: body.path,
        commit_sha: body.commit_sha ?? 'b'.repeat(40),
        content_sha256: 'd'.repeat(64),
        source_tool: body.source_tool ?? null,
        structure: 'manual_heading',
        acceptance_criteria: 2,
      },
    };
  }
  const plan = PLAN.exec(url.pathname);
  if (plan) {
    const intent = intentOf(plan[1]);
    if (!intent) return refusal(404, 'intent_not_found');
    if (!personA(intent)) return refusal(403, 'forbidden');
    if (body.commit_sha === OLD_COMMIT) {
      return refusal(409, 'plan_not_on_default_branch', 'not_on_default_branch');
    }
    return {
      status: 201,
      body: {
        intent: intent.code,
        version: 3,
        commit_sha: body.commit_sha ?? 'c'.repeat(40),
        plan_sha256: 'e'.repeat(64),
        planned_files: ['apps/api/src/orders/**'],
        allowed_tools: ['file_editor', 'terminal'],
        change_flags: [],
        created_at: NOW(),
      },
    };
  }
  const pack = PACK.exec(url.pathname);
  if (pack) {
    const intent = intentOf(pack[1]);
    if (!intent) return refusal(404, 'intent_not_found');
    const unchanged = intent.code === UNCHANGED;
    return {
      status: unchanged ? 200 : 201,
      body: {
        created: !unchanged,
        pack: { ...packOf(intent.code), built_by: USER, built_at: NOW() },
      },
    };
  }
  return refusal(404, 'not_found');
}
