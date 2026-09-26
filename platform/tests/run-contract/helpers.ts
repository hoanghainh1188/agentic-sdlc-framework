// Test helpers for Run Contracts (D-08 C02): a valid sample contract and a fake Transit key with
// real Ed25519 key versions, so signatures look exactly like OpenBao's (`vault:v<N>:<base64>`).
import crypto from 'node:crypto';

import type {
  RunContract,
  RunContractSigner,
  RunContractVerifier,
  SignatureResult,
} from '@sdlc/contracts';

export const SAMPLE_CONTRACT: RunContract = {
  schema_version: 1,
  run_id: '11111111-1111-4111-8111-111111111111',
  intent_id: '22222222-2222-4222-8222-222222222222',
  tenant_id: '33333333-3333-4333-8333-333333333333',
  project_id: '44444444-4444-4444-8444-444444444444',
  repo: 'org/pilot-order-inventory',
  base_sha: 'a'.repeat(40),
  branch: 'agent/INT-2026-0001',
  plan_id: '55555555-5555-4555-8555-555555555555',
  plan_sha256: 'b'.repeat(64),
  planned_files: ['apps/web/src/products/**', 'apps/api/src/products/list.ts'],
  agent_id: '66666666-6666-4666-8666-666666666666',
  agent_version: '1.4.0',
  instructions_sha256: 'c'.repeat(64),
  allowed_tools: ['editor', 'git', 'shell:test'],
  autonomy_level: 'L2',
  max_budget_usd: '2',
  max_iterations: 40,
  max_duration_min: 60,
  loop_threshold: 3,
  allowed_models: ['anthropic/claude-haiku-4-5-20251001'],
  egress_allowlist: ['api.github.com', 'github.com', 'litellm:4000'],
  issued_at: '2026-09-26T08:00:00.000Z',
  expires_at: '2026-09-26T08:15:00.000Z',
};

export function contract(overrides: Partial<Record<keyof RunContract, unknown>> = {}): RunContract {
  return { ...SAMPLE_CONTRACT, ...overrides } as RunContract;
}

/** A Transit key with several Ed25519 versions: signs with the latest, verifies by version. */
export class FakeTransit implements RunContractSigner, RunContractVerifier {
  readonly #versions: crypto.KeyPairKeyObjectResult[] = [crypto.generateKeyPairSync('ed25519')];

  rotate(): void {
    this.#versions.push(crypto.generateKeyPairSync('ed25519'));
  }

  sign(payload: Uint8Array, options: { keyVersion?: number } = {}): Promise<SignatureResult> {
    const keyVersion = options.keyVersion ?? this.#versions.length;
    const pair = this.#versions[keyVersion - 1]!;
    const raw = crypto.sign(null, payload, pair.privateKey).toString('base64');
    return Promise.resolve({ signature: `vault:v${String(keyVersion)}:${raw}`, keyVersion });
  }

  verify(payload: Uint8Array, signature: string): Promise<boolean> {
    const match = /^vault:v([0-9]+):(.+)$/.exec(signature);
    const pair = match ? this.#versions[Number(match[1]) - 1] : undefined;
    if (!match || !pair) return Promise.resolve(false);
    return Promise.resolve(
      crypto.verify(null, payload, pair.publicKey, Buffer.from(match[2]!, 'base64')),
    );
  }

  publicKey(keyVersion: number): Promise<Uint8Array> {
    const der = this.#versions[keyVersion - 1]!.publicKey.export({ format: 'der', type: 'spki' });
    return Promise.resolve(new Uint8Array(der.subarray(der.length - 32)));
  }
}
