# ADR-M52. SeaweedFS internal access: loopback binding and keys made at each start

| Item | Value |
|---|---|
| Status | **Proposed** (task A12, for review) |
| Date | 2026-10-04 |
| Decided by | Harry (plan approved 2026-10-04, with answers to QUESTIONS #239, #245, #246) |
| Related | D-08 task A12 (AC1–AC4); D-03 §9, §10; ADR-M12 (SeaweedFS); ADR-M17 (Compose); ADR-M33 §2.9 (gaps 3, 4); ADR-M51 §4 (gap 5, closed by this ADR); handbook T11 §5g–§5j; QUESTIONS #239, #245, #246 |

## 1. Context

SeaweedFS runs as one `weed server` process in the container `seaweedfs`: master, volume server, filer and S3 gateway. Every platform process reaches it through the S3 API with its own identity (`runner-evidence`, `api-evidence`, `worker-evidence`, `worker-purge`), and the bucket `evidence` has an object lock (ADR-M51).

Before A12 every part listened on `0.0.0.0`, without authentication. Every container on the Compose network `sdlc` could reach them (api, worker, runner, LiteLLM, Langfuse, Temporal…; sandboxes are not on that network). Checked live on SeaweedFS 4.48:

- **Gap 5 of ADR-M51 (QUESTIONS #239):** a filer `GET` on `seaweedfs:8888` read any file; an HTTP `DELETE` and `weed shell fs.rm` deleted a version with a COMPLIANCE lock and a legal hold. The volume server (8080) and the master (9333) answered too, and their gRPC ports (18080, 19333, 18888) let a `weed shell` from any container do anything.
- **A worse hole (QUESTIONS #245, found in the A12 spike):** the S3 gateway's own gRPC port, **18333**, offers `SeaweedS3IamCache/PutIdentity`, `RemoveIdentity`, `PutPolicy` and `SeaweedS3LifecycleInternal/LifecycleDelete`, with no authentication. One `PutIdentity` call from another container added an `Admin` identity; that identity read evidence through S3 (`200`) and could bypass GOVERNANCE. The S3 identities were therefore no boundary at all.
- The S3 gateway also opened an Iceberg REST catalog (8181) and a Lance namespace server (9101).

## 2. Decision

Two layers (option c of the plan): the internal parts are not reachable, and they need keys anyway.

### 2.1. Loopback binding

The `seaweedfs` command:

```text
server -dir=/data -ip=127.0.0.1 -ip.bind=127.0.0.1 -s3.ip.bind=0.0.0.0
       -master.volumeSizeLimitMB=… -volume.max=0
       -s3 -s3.port=8333 -s3.port.iceberg=0 -s3.port.lance=0
```

- The master (9333, 19333), the volume server (8080, 18080) and the filer (8888, 18888) listen on `127.0.0.1` inside the container only. `-ip=127.0.0.1` is also the address they advertise to each other, so the S3 gateway in the same process reaches them.
- Only the S3 API (8333) listens on the network. Iceberg and Lance are off.
- **The S3 gateway's gRPC port (18333) cannot be bound apart in SeaweedFS 4.48.** It always uses the S3 HTTP bind address (`-s3.ip.bind`); `weed server` has only `-s3.port.grpc`, and `-s3.port.grpc=0` still opens 18333 (checked live). A separate `weed s3` process has one `-ip.bind` for both too. So 18333 stays reachable on the network; the filer key (§2.2) is what refuses its calls (`Unauthenticated: missing authorization metadata`, checked live). The live test proves it on every CI run.

### 2.2. JWT keys made at each start

`platform/deploy/seaweedfs/start.sh` is the container's entrypoint. Before SeaweedFS starts, it writes four random keys (32 bytes from `/dev/urandom` each, as hex) to `/etc/seaweedfs/security.toml`:

| Section | Protects |
|---|---|
| `jwt.signing` | writes to the volume server |
| `jwt.signing.read` | reads from the volume server |
| `jwt.filer_signing` | filer writes, the filer's IAM gRPC service and the S3 gateway's gRPC port 18333 |
| `jwt.filer_signing.read` | filer reads |

- **Held nowhere else (QUESTIONS #246).** Only SeaweedFS uses the keys: all its parts run in one process, and `docker compose exec seaweedfs weed shell` reads the same file. They are new at every start: no key in `.env`, OpenBao, a volume or the repository. A restart rotates them; no client outside the container holds one, so nothing breaks.
- **Fails closed.** The script exits non-zero, and SeaweedFS does not start, when it is not root, `/dev/urandom` is not readable or gives too few bytes, the file cannot be written, its owner or mode cannot be set, or the result is not mode 600, owner `seaweed`, with four 64-character keys. It then hands over to the image's entrypoint, which drops to the user `seaweed`. It never prints a key.

### 2.3. Admin work and `seaweedfs-init`

- `weed shell` runs only inside the container: `docker compose exec seaweedfs weed shell -master=127.0.0.1:9333` (runbook T11, `bootstrap.sh`). The name `seaweedfs` now points at the container's network address, where the master does not listen.
- `seaweedfs-init` runs in the network namespace of `seaweedfs` (`network_mode: service:seaweedfs`) and uses `127.0.0.1`. Its commands (create a bucket, versioning, lock, the S3 lock call) need no key. No other service may join that namespace (static test).
- Langfuse uses only the S3 API and its own bucket: unchanged.

### 2.4. Tests

- **Static (`pnpm test`, `platform/tests/deploy/seaweedfs-static.test.ts`, AC4):** the exact `seaweedfs` command; `start.sh` as entrypoint, mounted read-only; only 8333 published; `seaweedfs-init` alone in the shared namespace; no script reaches the master, filer or volume by the service name; no key in the compose file or `.env`; `start.sh` stops on every error, checks mode and owner, writes four keys and starts SeaweedFS only as its last step.
- **Live (`pnpm test:seaweedfs`, a step of the CI `compose` job; also part of `pnpm test:compose`; `platform/tests/integration/deploy/seaweedfs-access.test.ts`, AC2):** a throw-away project with `seaweedfs` and `seaweedfs-init`. An evidence object with a GOVERNANCE lock and a legal hold; from other containers on the network a filer GET and DELETE, a direct volume read and delete, the master, Iceberg, Lance and a `weed shell` are refused; 18333 offers exactly the four reviewed gRPC services (a new one fails the test), and every IAM cache method and `LifecycleDelete` without a key is refused with `Unauthenticated`; the identity `PutIdentity` tried to add has no access; afterwards the version, its hold and its content are unchanged. Inside the container: only 8333 and 18333 listen outside loopback, `security.toml` is mode 600 with four keys, a read without a token gets `401`, and `weed shell` works, an IAM change too (an identity it adds can read). Each refusal has a positive control (the probe reaches S3; the same listing from the container's own namespace shows the object). `start.sh` fails closed with no random bytes, a read-only file system and a non-root user.
- The purge identity's S3 bypass stays covered by `retention-purge.test.ts` (`pnpm test:openbao`).

## 3. Alternatives

- **Binding only:** leaves 18333 open (§2.1), so the IAM hole stays.
- **Keys only:** the parts stay reachable; any new SeaweedFS listener or a key mistake reopens everything. Two layers cost one script.
- **Keys in `.env` or OpenBao:** nobody outside the container needs them; storing them only adds places to leak them and a rotation procedure.
- **gRPC mutual TLS (`[grpc]` in `security.toml`):** would also protect 18333, but needs a CA and certificates per installation and per component. Not needed while every client of the gRPC ports is inside the container.

## 4. Consequences

- ADR-M51 gap 5 is **closed**: no other process can read, write or delete evidence except through the S3 API with an identity, and the object lock and legal holds apply on every path except the purge identity's S3 bypass.
- **Still open, accepted:**
  - anyone who can run `docker compose exec` (or `docker exec`) on the host can use `weed shell` as root inside the container, `fs.rm` included. That is host-admin access; the runner's socket proxy has no exec endpoint (ADR-M25);
  - ADR-M33 gap 3: the `.env` S3 admin identity can bypass GOVERNANCE (unchanged);
  - ADR-M33 gap 4: the S3 secrets sit in the filer store on disk (unchanged);
  - 18333 is reachable and protected by the filer key only (§2.1).
- **Upgrades:** a new SeaweedFS version may add a listener. The static test pins the command and the live test lists every port listening outside loopback, so CI fails until the new port is reviewed.
- **Migration:** none. Data written before the change stays readable (the filer stores file IDs, not addresses; checked live). `pnpm compose:core` recreates `seaweedfs` and re-runs `seaweedfs-init`.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-04 | Claude (task A12) | First version |
