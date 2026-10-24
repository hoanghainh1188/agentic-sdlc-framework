// L01 (design/ADR-M71 §2.4): `docker run` arguments of the stub that stands in for vLLM in the
// LiteLLM live test. On the internal network `models` with the alias `vllm` and port 8000, as on a
// server; no key (STUB_OPEN=1), because only LiteLLM reaches vllm there.

/** Arguments for `docker run`: a detached container named `name` on `network`. */
export function vllmStubArgs(
  name: string,
  network: string,
  stubFile: string,
  image: string,
): string[] {
  return [
    'run',
    '-d',
    '--name',
    name,
    '--network',
    network,
    '--network-alias',
    'vllm',
    '-e',
    'STUB_OPEN=1',
    '-e',
    'STUB_PORT=8000',
    '-v',
    `${stubFile}:/stub.mjs:ro`,
    image,
    'node',
    '/stub.mjs',
  ];
}
