// X01 spike (design/ADR-M68): a small HTTP supervisor for Aider, because Aider is a CLI with no
// server and the runner's Docker client has no `exec` (ADR-M25). It plays the Agent Server's part:
//   POST /run    {model, baseUrl, key, maxIterations, messageFile, files[], readFiles[], testCmd}
//   GET  /status → {state, iterations, events, identicalCalls, exitCode}
//   GET  /events → one {kind, sha256} per model reply (hashes only)
//   POST /stop   → SIGINT to Aider, SIGKILL after 10 s
//   POST /bash   {command} → {exitCode, stdout} (the platform's commit and diff, ADR-M29 §2.5)
// Every call needs `Authorization: Bearer <SESSION_API_KEY>`; the key is removed from the
// environment of every child process. Health: GET /alive without a key.
//
// Counts come from Aider's LLM history file: one model reply = one iteration; identical replies
// at the end (same SHA-256) stand in for identical tool calls, since Aider has no tool calls. The
// iteration cap is enforced here: Aider has none of its own.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';

const KEY = process.env.SESSION_API_KEY ?? '';
if (KEY.length < 32) throw new Error('SESSION_API_KEY missing');
const childEnv = { ...process.env };
delete childEnv.SESSION_API_KEY;
delete childEnv.OH_SECRET_KEY;

const STATE_DIR = '/tmp/aider';
const HISTORY = `${STATE_DIR}/llm-history.txt`;
let child = null;
let state = 'idle';
let exitCode = null;
let maxIterations = 0;
let capHit = false;
let stopRequested = false;
let cleaned = 0;

function replies() {
  let text;
  try {
    text = fs.readFileSync(HISTORY, 'utf8');
  } catch {
    return [];
  }
  // Aider writes `<ROLE> <timestamp>` headers; a block after `LLM RESPONSE` is one model reply.
  return text
    .split(/^LLM RESPONSE .*$/m)
    .slice(1)
    .map((block) => block.split(/^TO LLM .*$/m)[0] ?? '');
}

function counts() {
  const all = replies();
  const hashes = all.map((r) => crypto.createHash('sha256').update(r.trim()).digest('hex'));
  let identical = 0;
  for (let i = hashes.length - 1; i >= 0 && hashes[i] === hashes[hashes.length - 1]; i--) {
    identical += 1;
  }
  let requests = 0;
  try {
    requests = (fs.readFileSync(HISTORY, 'utf8').match(/^TO LLM /gm) ?? []).length;
  } catch {
    // no history yet
  }
  return { iterations: all.length, events: all.length + requests, identicalCalls: identical };
}

function startAider(body) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  maxIterations = body.maxIterations;
  const args = [
    '--model',
    `openai/${body.model}`,
    '--openai-api-base',
    body.baseUrl,
    '--model-metadata-file',
    `${STATE_DIR}/model-metadata.json`,
    '--message-file',
    body.messageFile,
    '--yes-always',
    '--no-auto-commits',
    '--no-dirty-commits',
    '--no-pretty',
    '--no-stream',
    '--no-fancy-input',
    '--no-show-model-warnings',
    '--no-check-update',
    '--analytics-disable',
    '--no-gitignore',
    '--edit-format',
    'diff',
    '--map-tokens',
    '1024',
    '--llm-history-file',
    HISTORY,
    '--chat-history-file',
    `${STATE_DIR}/chat.md`,
    '--input-history-file',
    `${STATE_DIR}/input.txt`,
    ...(body.testCmd ? ['--auto-test', '--test-cmd', body.testCmd] : []),
    ...body.readFiles.flatMap((f) => ['--read', f]),
    ...body.files.flatMap((f) => ['--file', f]),
  ];
  fs.writeFileSync(
    `${STATE_DIR}/model-metadata.json`,
    JSON.stringify({
      [`openai/${body.model}`]: {
        max_input_tokens: body.contextTokens,
        max_output_tokens: 8192,
        litellm_provider: 'openai',
        mode: 'chat',
        input_cost_per_token: 0,
        output_cost_per_token: 0,
      },
    }),
  );
  state = 'running';
  // The model key goes to Aider's process only; Aider's shell commands inherit it (a gap).
  child = spawn('aider', args, {
    cwd: '/workspace',
    env: { ...childEnv, OPENAI_API_KEY: body.key, HOME: process.env.HOME },
    stdio: [
      'ignore',
      fs.openSync(`${STATE_DIR}/stdout.txt`, 'a'),
      fs.openSync(`${STATE_DIR}/stderr.txt`, 'a'),
    ],
  });
  child.on('exit', (code, signal) => {
    exitCode = code ?? (signal ? 128 : -1);
    // Aider keeps its repository map cache in the repository (`.aider.tags.cache.v4/`); it would
    // count as a change outside the plan at G5. The supervisor removes what Aider left there.
    for (const entry of fs.readdirSync('/workspace')) {
      if (entry.startsWith('.aider')) {
        fs.rmSync(`/workspace/${entry}`, { recursive: true, force: true });
        cleaned += 1;
      }
    }
    if (capHit) state = 'max_iterations';
    else if (stopRequested) state = 'stopped';
    else state = code === 0 ? 'finished' : 'error';
    child = null;
  });
}

function stopAider() {
  if (!child) return;
  stopRequested = true;
  child.kill('SIGINT');
  const c = child;
  setTimeout(() => c.exitCode === null && c.kill('SIGKILL'), 10_000).unref();
}

// The iteration cap: Aider has none, so the supervisor stops it at the cap.
setInterval(() => {
  if (child && maxIterations > 0 && counts().iterations >= maxIterations && !capHit) {
    capHit = true;
    stopAider();
  }
}, 500).unref();

const read = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (e) {
        reject(e);
      }
    });
  });

const reply = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const authorised = (req) => {
  const given = Buffer.from(req.headers.authorization ?? '');
  const wanted = Buffer.from(`Bearer ${KEY}`);
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
};

http
  .createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/alive') return reply(res, 200, { ok: true });
      if (!authorised(req)) return reply(res, 401, { error: 'unauthorized' });
      if (req.method === 'POST' && req.url === '/run') {
        if (state !== 'idle') return reply(res, 409, { error: 'already_started' });
        startAider(await read(req));
        return reply(res, 202, { state });
      }
      if (req.method === 'GET' && req.url === '/status') {
        return reply(res, 200, { state, exitCode, cleaned, ...counts() });
      }
      if (req.method === 'GET' && req.url === '/events') {
        const events = replies().map((r) => ({
          kind: 'llm_reply',
          sha256: crypto.createHash('sha256').update(r.trim()).digest('hex'),
        }));
        return reply(res, 200, { events });
      }
      if (req.method === 'POST' && req.url === '/stop') {
        stopAider();
        return reply(res, 202, { state });
      }
      if (req.method === 'POST' && req.url === '/bash') {
        const { command } = await read(req);
        const r = spawnSync('sh', ['-c', command], {
          cwd: '/workspace',
          env: childEnv,
          encoding: 'utf8',
          timeout: 120_000,
          maxBuffer: 16 * 1024 * 1024,
        });
        return reply(res, 200, { exitCode: r.status ?? -1, stdout: r.stdout ?? '' });
      }
      return reply(res, 404, { error: 'not_found' });
    } catch {
      return reply(res, 500, { error: 'server_error' });
    }
  })
  .listen(8000, '0.0.0.0');
