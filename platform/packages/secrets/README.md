# @sdlc/secrets

OpenBao client for the platform processes (task A04, design/ADR-M21).

- AppRole login from a role ID file and a secret ID file (never environment variables). The secret ID file is read again at every login.
- Token renewal at 2/3 of the TTL; a new login when the maximum TTL is near or the token was revoked.
- KV v2 read (`client.kv().read('worker/db')`): values are `Redacted`; call `reveal()` only where the value is used.
- Transit Ed25519 sign and verify for Run Contracts (`client.transit()`), through OpenBao or locally with the public key.
- Clear errors (message catalog) when OpenBao is sealed or not initialised, unreachable, or refuses a request.
- TLS: the server certificate is always verified; `SDLC_OPENBAO_CA_CERT_FILE` names the CA (in Compose `/run/sdlc/openbao-ca/ca.pem`, A10, `design/ADR-M63-openbao-tls-and-backups.md`). Plain `http://` only with `SDLC_OPENBAO_ALLOW_PLAINTEXT=1`, which no compose service sets since A10 (unit tests against a stub may).

```ts
const client = OpenBaoClient.fromEnv();
await client.assertReady();
const github = await client.kv().read('shared/github-app');
const { signature, keyVersion } = await client.transit().sign(contractBytes);
```

Other packages depend on the interfaces in `@sdlc/contracts` (`SecretReader`, `RunContractSigner`, `RunContractVerifier`), not on this package.

Tests: `platform/tests/secrets/` (`pnpm test`) and `platform/tests/integration/openbao/secrets-client.test.ts` (`pnpm test:openbao`, needs Docker).
