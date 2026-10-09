// Runs the built @sdlc/secrets client INSIDE a container on the throw-away Compose network, like a
// platform process (task A04, secrets-client.test.ts). The package has no runtime dependencies,
// so the host build works in a Linux container without node_modules for Linux.
//
// stdin: one JSON object { roleId, secretId, adminToken?, steps: [...] }. The credentials are
// THROW-AWAY TEST values. They are written to a tmpfs (mode 600) for the client, as a deployment
// would, and never printed. stdout: one JSON object with results that hold no secret: error keys,
// booleans, versions, signatures (not secret) and logger events.
import fs from 'node:fs';
import https from 'node:https';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { OpenBaoClient, Redacted, SecretsError } = require(process.env.SECRETS_DIST);

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const dir = '/run/sdlc';
fs.writeFileSync(`${dir}/role-id`, `${input.roleId ?? 'none'}\n`, { mode: 0o600 });
fs.writeFileSync(`${dir}/secret-id`, `${input.secretId ?? 'none'}\n`, { mode: 0o600 });

const events = [];
const logger = { log: (level, event, fields) => events.push({ level, event, fields }) };
const client = new OpenBaoClient({
  address: process.env.SDLC_OPENBAO_ADDR,
  // TLS since A10 (ADR-M63): the CA of the project's volume openbao-ca.
  caCertFile: process.env.SDLC_OPENBAO_CA_CERT_FILE,
  roleIdFile: `${dir}/role-id`,
  secretIdFile: `${dir}/secret-id`,
  logger,
});

const outcome = async (fn) => {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    if (error instanceof SecretsError) return { ok: false, key: error.key, message: error.message };
    return { ok: false, key: 'not-a-secrets-error', message: String(error?.code ?? 'unknown') };
  }
};
const bytes = (text) => new TextEncoder().encode(text);
// A wrapping token made by the `wrap` step. It stays inside this process: never in the output.
let wrappingToken;

const steps = {
  ready: () => client.assertReady().then(() => 'ready'),
  login: () => client.login().then(() => client.tokenInfo()),
  read: ({ path, expect }) =>
    client
      .kv()
      .read(path)
      .then((e) => ({ version: e.version, matches: e.data.value?.reveal() === expect })),
  sign: ({ payload }) => client.transit().sign(bytes(payload)),
  verify: ({ payload, signature }) => client.transit().verify(bytes(payload), signature),
  verifyLocally: ({ payload, signature }) =>
    client.transit().verifyLocally(bytes(payload), signature),
  publicKeyLength: ({ version }) =>
    client
      .transit()
      .publicKey(version)
      .then((k) => k.length),
  renew: async () => {
    const before = client.tokenInfo();
    await client.renewNow();
    const after = client.tokenInfo();
    return { renewed: after.expiresAt >= before.expiresAt, renewable: after.renewable };
  },
  // Revokes every AppRole token with the throw-away admin token, as an operator could.
  revokeAllTokens: async () => {
    // node:https with the CA: the global fetch would not use the client's CA (A10).
    const url = `${process.env.SDLC_OPENBAO_ADDR}/v1/sys/leases/revoke-prefix/auth/approle/login`;
    const ca = fs.readFileSync(process.env.SDLC_OPENBAO_CA_CERT_FILE);
    return new Promise((resolve, reject) => {
      const req = https.request(
        url,
        { method: 'POST', headers: { 'X-Vault-Token': input.adminToken }, ca },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', reject);
      req.end();
    });
  },
  loginCount: () => events.filter((e) => e.event === 'openbao.login').length,
  wrap: ({ value, ttlSeconds }) =>
    client
      .wrapping()
      .wrap({ token: new Redacted(value) }, { ttlSeconds })
      .then((token) => {
        wrappingToken = token;
        return 'wrapped';
      }),
  unwrap: ({ expect }) =>
    client
      .wrapping()
      .unwrap(wrappingToken)
      .then((fields) => ({ matches: fields.token?.reveal() === expect })),
  close: () => client.close().then(() => 'closed'),
};

const results = [];
for (const step of input.steps)
  results.push({ step: step.name, ...(await outcome(() => steps[step.name](step))) });
await client.close().catch(() => undefined);
process.stdout.write(JSON.stringify({ results, events }));
