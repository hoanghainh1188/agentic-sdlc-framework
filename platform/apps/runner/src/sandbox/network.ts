// Sandbox egress (D-03 §9 v1.6, ADR-M25 §2.2). The rule is enforced by the network layout, not by
// firewall rules, so it behaves the same on Docker Desktop and on Linux:
//
// - each run gets its own Docker network, `internal: true`: Docker gives it no route out and its
//   DNS resolves only the containers attached to it;
// - the sandbox joins that network only;
// - the runner attaches exactly the services the contract allows (LiteLLM, the package proxy) under
//   their aliases, and detaches them at clean-up;
// - two runs never share a network, so two sandboxes (maybe of two tenants) cannot talk.
//
// GitHub is never on the list: the runner clones and pushes, the sandbox never does (QUESTIONS #52).
import type { NetworkSpec } from '../docker/client.js';
import type { RunNames } from '../names.js';
import type { EgressService } from '../settings.js';

export type EgressPlan =
  | { readonly ok: true; readonly services: readonly EgressService[] }
  | { readonly ok: false; readonly reason: 'egress_not_enforceable' };

/**
 * Maps the contract's `egress_allowlist` (`alias:port` entries) to the configured services. An
 * entry the runner cannot enforce (an internet host such as `github.com`, an unknown alias, a
 * wrong port) makes the plan fail: the runner refuses the run rather than open more than allowed.
 */
export function planEgress(
  allowlist: readonly string[],
  services: readonly EgressService[],
): EgressPlan {
  const chosen: EgressService[] = [];
  for (const entry of allowlist) {
    const match = /^([a-z][a-z0-9-]*):([0-9]{1,5})$/.exec(entry);
    const service = services.find((s) => s.alias === match?.[1] && String(s.port) === match[2]);
    if (!service) return { ok: false, reason: 'egress_not_enforceable' };
    if (!chosen.includes(service)) chosen.push(service);
  }
  return { ok: true, services: chosen };
}

/**
 * The bridge of an internal network gets no IP address. Without this option Docker gives the bridge
 * the network's gateway address, and the sandbox can reach **every service listening in the host's
 * network namespace** through it (found by the CI live test on Linux, ADR-M25 §2.2). With it, the
 * host has no address on the run's network, and the network has no gateway and no route out.
 */
export const INHIBIT_IPV4 = 'com.docker.network.bridge.inhibit_ipv4';

/** The run's internal network. */
export function runNetworkSpec(
  names: RunNames,
  labels: Readonly<Record<string, string>>,
): NetworkSpec {
  return {
    Name: names.network,
    Driver: 'bridge',
    Internal: true,
    Attachable: false,
    EnableIPv6: false,
    Labels: labels,
    Options: { [INHIBIT_IPV4]: 'true' },
  };
}
