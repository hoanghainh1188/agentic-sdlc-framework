// The evaluation harness (task L02, design/ADR-M78): the task set and its checks, configurations,
// run results that hold numbers and codes only (AC6), diff counts and the scoring script. The runs
// themselves are live (`pnpm eval`, developer machines only).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  checkRunResult,
  diffStats,
  hasRunResult,
  litellmModelList,
  loadConfigurations,
  loadTask,
  loadTaskSet,
  parseScore,
  readRunResults,
  resultPath,
  scoringScript,
  writeRunResult,
  type RunResult,
} from '../../eval/src/index.js';
import { repoRoot } from '../workspace/helpers';

const V1 = path.join(repoRoot(), 'platform/eval/tasks/v1');
const CONFIGS = path.join(repoRoot(), 'platform/eval/configs');
const dirs: string[] = [];
const temp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-eval-unit-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const result = (over: Partial<Record<keyof RunResult, unknown>> = {}): Record<string, unknown> => ({
  schema: 1,
  task_set: 1,
  task: 'feat-tax',
  configuration: 'gpt-oss-20b',
  model: 'gpt-oss-20b',
  agent_version: '1.0.0',
  instructions_sha256: 'a'.repeat(64),
  run: 1,
  outcome: 'finished',
  status: 'succeeded',
  stop_reason: null,
  applied: true,
  resolved: true,
  fail_to_pass_passed: true,
  pass_to_pass_passed: true,
  ci_passed: true,
  scope_breach: false,
  out_of_plan_files: 0,
  lint_findings: 0,
  diff_files: 2,
  diff_lines_added: 30,
  diff_lines_removed: 1,
  seconds: 300,
  iterations: 12,
  model_calls: 14,
  input_tokens: 90000,
  output_tokens: 4000,
  cached_input_tokens: 50000,
  cost_usd: '0.010600',
  ...over,
});

/** A minimal valid task folder; `edit` changes it before it is read. */
function taskDir(edit: (dir: string) => void = () => undefined, id = 'feat-x'): string {
  const dir = path.join(temp(), id);
  fs.mkdirSync(path.join(dir, 'hidden/apps/api/src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'task.yaml'),
    [
      'schema: 1',
      `id: ${id}`,
      'title: A task',
      'kind: feature',
      'shape: T02',
      'planned_files: [apps/api/src/x.ts]',
      'fail_to_pass: [pnpm --filter @pilot/api test -- x.hidden]',
      'pass_to_pass: [pnpm --filter @pilot/api test]',
      'ci: [pnpm lint]',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(dir, 'spec.md'), '# Task\n');
  fs.writeFileSync(path.join(dir, 'hidden/apps/api/src/x.hidden.spec.ts'), 'test\n');
  edit(dir);
  return dir;
}
const setYaml = (dir: string, from: string, to: string) => {
  const file = path.join(dir, 'task.yaml');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(from, to));
};

describe('task set v1 (AC1, AC8)', () => {
  it('loads eight tasks sorted by id, at a pinned commit, version 1', () => {
    const set = loadTaskSet(V1);
    expect(set.version).toBe(1);
    expect(set.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(set.tasks.map((t) => t.id)).toEqual([
      'bug-like-escape',
      'bug-merge-order',
      'bug-order-number',
      'bug-shortage-exact',
      'feat-low-stock',
      'feat-paging',
      'feat-sku-rule',
      'feat-tax',
    ]);
  });

  it('every task has hidden tests, a reference solution and a spec that never names them', () => {
    for (const task of loadTaskSet(V1).tasks) {
      expect(task.hiddenFiles.length, task.id).toBeGreaterThan(0);
      expect(task.solutionPatch, task.id).not.toBeNull();
      expect(task.specText, task.id).not.toMatch(/hidden/i);
      for (const file of task.hiddenFiles) expect(task.specText).not.toContain(path.basename(file));
      // The hidden tests are what fail_to_pass runs.
      const pattern = task.failToPass[0]!.split(' -- ')[1]!;
      expect(
        task.hiddenFiles.some((f) => f.includes(pattern)),
        task.id,
      ).toBe(true);
    }
  });

  it('bugs have a seed patch, features none', () => {
    for (const task of loadTaskSet(V1).tasks) {
      expect(task.seedPatch === null, task.id).toBe(task.kind === 'feature');
    }
  });

  it('keeps the named tasks only, and refuses an unknown one', () => {
    expect(loadTaskSet(V1, ['feat-tax', 'bug-merge-order']).tasks.map((t) => t.id)).toEqual([
      'bug-merge-order',
      'feat-tax',
    ]);
    expect(() => loadTaskSet(V1, ['nope'])).toThrow(/unknown task nope/);
  });
});

describe('a task is read strictly', () => {
  it('reads a valid task', () => {
    const task = loadTask(taskDir());
    expect(task).toMatchObject({ id: 'feat-x', kind: 'feature', seedPatch: null });
    expect(task.hiddenFiles).toEqual(['apps/api/src/x.hidden.spec.ts']);
  });

  it.each([
    [
      'an unknown field',
      (d: string) => setYaml(d, 'title: A task', 'title: A task\nnote: x'),
      /unknown field/,
    ],
    [
      'shell syntax in a command',
      (d: string) => setYaml(d, 'ci: [pnpm lint]', "ci: ['pnpm lint; curl x']"),
      /ci/,
    ],
    [
      'a path out of the repository',
      (d: string) => setYaml(d, 'apps/api/src/x.ts', '../x.ts'),
      /planned_files/,
    ],
    [
      'a path into .git',
      (d: string) => setYaml(d, 'apps/api/src/x.ts', '.git/config'),
      /planned_files/,
    ],
    [
      'a seed on a feature',
      (d: string) => fs.writeFileSync(path.join(d, 'seed.patch'), 'x'),
      /no seed/,
    ],
    [
      'a bug without a seed',
      (d: string) => setYaml(d, 'kind: feature', 'kind: bug'),
      /seed\.patch/,
    ],
    ['no spec', (d: string) => fs.rmSync(path.join(d, 'spec.md')), /spec\.md/],
    [
      'an empty hidden folder',
      (d: string) => fs.rmSync(path.join(d, 'hidden/apps'), { recursive: true }),
      /no file/,
    ],
    [
      'a link in hidden/',
      (d: string) => fs.symlinkSync('/etc/hosts', path.join(d, 'hidden/apps/api/src/link.ts')),
      /link/,
    ],
    [
      'an id that is not the folder',
      (d: string) => setYaml(d, 'id: feat-x', 'id: feat-y'),
      /folder name/,
    ],
  ])('refuses %s', (_name, edit, message) => {
    expect(() => loadTask(taskDir(edit))).toThrow(message);
  });
});

describe('configurations (AC2, AC6)', () => {
  it('loads the local and stub configurations', () => {
    const local = loadConfigurations(path.join(CONFIGS, 'local.yaml'));
    expect(local.map((c) => [c.id, c.model.provider, c.model.tag])).toEqual([
      ['gpt-oss-20b', 'ollama', 'gpt-oss:20b'],
      ['qwen3-8b', 'ollama', 'qwen3:8b'],
    ]);
    expect(loadConfigurations(path.join(CONFIGS, 'stub.yaml'))[0]!.model).toMatchObject({
      provider: 'stub',
      tag: null,
    });
  });

  const write = (text: string, extra: Record<string, string> = {}): string => {
    const dir = temp();
    for (const [name, content] of Object.entries(extra))
      fs.writeFileSync(path.join(dir, name), content);
    fs.writeFileSync(path.join(dir, 'c.yaml'), text);
    return path.join(dir, 'c.yaml');
  };
  const one = (model: string, more = '') =>
    `schema: 1\nconfigurations:\n  - id: a\n    agent_version: 1.0.0\n    model: ${model}\n${more}`;

  it.each([
    ['a cloud model', "{ provider: ollama, name: m, tag: 'gpt-oss:120b-cloud' }", /cloud/],
    ['a :cloud tag', "{ provider: ollama, name: m, tag: 'kimi-k2.5:cloud' }", /cloud/],
    ['an unknown provider', '{ provider: openai, name: m }', /provider/],
    ['a stub with a tag', "{ provider: stub, name: m, tag: 'x:1' }", /only a name/],
    ['an unknown field', '{ provider: stub, name: m, key: secret }', /unknown field/],
  ])('refuses %s', (_name, model, message) => {
    expect(() => loadConfigurations(write(one(model)))).toThrow(message);
  });

  it('refuses repeated ids and keeps the named configurations', () => {
    const twice = `${one('{ provider: stub, name: m }')}  - id: a\n    agent_version: 1.0.0\n    model: { provider: stub, name: m }\n`;
    expect(() => loadConfigurations(write(twice))).toThrow(/repeat/);
    const file = path.join(CONFIGS, 'local.yaml');
    expect(loadConfigurations(file, ['qwen3-8b']).map((c) => c.id)).toEqual(['qwen3-8b']);
    expect(() => loadConfigurations(file, ['nope'])).toThrow(/unknown configuration/);
  });

  it('reads an instructions file and hashes it; a missing one is refused', () => {
    const file = write(one('{ provider: stub, name: m }', '    instructions: short.md\n'), {
      'short.md': '# Short instructions\n',
    });
    const [config] = loadConfigurations(file);
    expect(config!.instructionsText).toBe('# Short instructions\n');
    expect(config!.instructionsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() =>
      loadConfigurations(write(one('{ provider: stub, name: m }', '    instructions: gone.md\n'))),
    ).toThrow(/missing/);
  });

  it('writes the LiteLLM model list for Ollama models only, once each, self-hosted with a cost', () => {
    const text = litellmModelList(
      loadConfigurations(path.join(CONFIGS, 'local.yaml')),
      'http://h:11434',
    );
    expect(text.match(/model_name:/g)).toHaveLength(2);
    expect(text).toContain('model: ollama_chat/gpt-oss:20b');
    expect(text).toContain('reasoning_effort: low');
    expect(text.match(/provider_type: self_hosted/g)).toHaveLength(2);
    expect(text).toContain('input_cost_per_token: 0.0000001');
    expect(litellmModelList(loadConfigurations(path.join(CONFIGS, 'stub.yaml')), 'x')).toBe(
      'model_list:\n\n',
    );
  });
});

describe('run results hold numbers and codes only (AC3, AC6)', () => {
  it('accepts a full result', () => {
    expect(checkRunResult(result())).toMatchObject({ resolved: true, cost_usd: '0.010600' });
  });

  it.each([
    ['an undeclared field', { prompt: 'Fix the bug' }],
    ['text in a code field', { status: 'it succeeded' }],
    ['a path in a code field', { stop_reason: 'apps/api/src/x.ts' }],
    ['an e-mail in the model', { model: 'a@b.example' }],
    ['a float cost', { cost_usd: 0.0106 }],
    ['a cost with 2 decimals', { cost_usd: '0.01' }],
    ['a negative count', { iterations: -1 }],
    ['a float count', { seconds: 1.5 }],
    ['resolved without the hidden tests', { fail_to_pass_passed: false }],
    ['another schema', { schema: 2 }],
  ])('refuses %s', (_name, over) => {
    expect(() => checkRunResult(result(over as Partial<Record<keyof RunResult, unknown>>))).toThrow(
      TypeError,
    );
  });

  it('writes one file per run, skips it when valid, and reads every result back', () => {
    const out = temp();
    const key = { taskSet: 1, configuration: 'gpt-oss-20b', task: 'feat-tax', run: 1 };
    expect(hasRunResult(out, key)).toBe(false);
    const file = writeRunResult(out, result() as unknown as RunResult);
    expect(file).toBe(resultPath(out, key));
    expect(file.endsWith(path.join('v1', 'gpt-oss-20b', 'feat-tax', 'run-1.json'))).toBe(true);
    expect(hasRunResult(out, key)).toBe(true);
    writeRunResult(
      out,
      result({ run: 2, resolved: false, fail_to_pass_passed: false }) as unknown as RunResult,
    );
    expect(
      readRunResults(out, 1)
        .map((r) => r.run)
        .sort(),
    ).toEqual([1, 2]);
    // A damaged file is not a result: the run is done again.
    fs.writeFileSync(file, '{"schema":1');
    expect(hasRunResult(out, key)).toBe(false);
    expect(fs.readdirSync(path.dirname(file)).some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('never writes a result with text', () => {
    expect(() =>
      writeRunResult(temp(), result({ outcome: 'the agent said: done' }) as unknown as RunResult),
    ).toThrow(TypeError);
  });
});

describe('diff counts', () => {
  it('counts files and lines, not the header lines', () => {
    const patch = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,2 +1,3 @@',
      ' keep',
      '-old',
      '+new',
      '+more',
      'diff --git a/y.ts b/y.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/y.ts',
      '@@ -0,0 +1 @@',
      '+y',
      '',
    ].join('\n');
    expect(diffStats(patch)).toEqual({ files: 2, added: 3, removed: 1 });
    expect(diffStats('')).toEqual({ files: 0, added: 0, removed: 0 });
  });
});

describe('the scoring script (ADR-M78 §2.3)', () => {
  const task = loadTaskSet(V1, ['feat-tax']).tasks[0]!;

  it('applies the base and the agent change, then CI, pass_to_pass, the hidden files and fail_to_pass, in that order', () => {
    const script = scoringScript(task);
    const at = (text: string) => script.indexOf(text);
    expect(at('git apply --whitespace=nowarn /workspace/in/base.patch')).toBeGreaterThan(-1);
    expect(at('/workspace/in/agent.patch')).toBeGreaterThan(at('/workspace/in/base.patch'));
    expect(at("'pnpm lint'")).toBeGreaterThan(at('/workspace/in/agent.patch'));
    expect(at("'pnpm --filter @pilot/api test'")).toBeGreaterThan(at("'pnpm lint'"));
    expect(at('cp -R /workspace/in/hidden/.')).toBeGreaterThan(
      at("'pnpm --filter @pilot/api test'"),
    );
    expect(at('tax-rules.hidden')).toBeGreaterThan(at('cp -R /workspace/in/hidden/.'));
    // The hidden tests are never in the agent's repository before scoring.
    expect(at('cp -R /workspace/in/hidden/.')).toBeGreaterThan(at('/workspace/in/agent.patch'));
  });

  it('refuses a command with a quote', () => {
    expect(() => scoringScript({ ...task, ci: ["pnpm lint'"] })).toThrow(/quote/);
  });

  it('reads the score file strictly', () => {
    expect(
      parseScore('{"applied":true,"ci":false,"pass_to_pass":true,"fail_to_pass":true,"lint":3}'),
    ).toEqual({ applied: true, ci: false, passToPass: true, failToPass: true, lintFindings: 3 });
    expect(() =>
      parseScore('{"applied":"yes","ci":false,"pass_to_pass":true,"fail_to_pass":true,"lint":0}'),
    ).toThrow(/applied/);
    expect(() =>
      parseScore('{"applied":true,"ci":true,"pass_to_pass":true,"fail_to_pass":true,"lint":-1}'),
    ).toThrow(/lint/);
  });
});
