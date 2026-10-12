// Checks of team access (V09, design/ADR-M67 §2.8). Pure. Without the profile `access` configured,
// one line says it is off and the published ports are still checked (every port on 127.0.0.1).
import type { AccessFact, CheckResult, OperatorFacts, ServiceState } from '../types.js';
import { ok, problem, skipped, text } from './result.js';

const DAY_MS = 86_400_000;
export const ACCESS_TLS_WARNING_DAYS = 30;
/** Host addresses that are this machine only. */
const LOOPBACK = new Set(['127.0.0.1', '::1']);
const PROXY = 'sdlc-access';

const readme = () => text('doctor.fix.readme', { section: 'Team access (operator)' });
const t11 = () => text('doctor.fix.runbook', { section: '§3d' });

/** The public origin the proxy serves: `https://<host name>`, with the port unless 443. */
export function expectedOrigin(a: AccessFact): string | null {
  if (!a.hostname) return null;
  return a.hostPort === '443' ? `https://${a.hostname}` : `https://${a.hostname}:${a.hostPort}`;
}

function portsCheck(a: AccessFact, services: readonly ServiceState[] | null | undefined) {
  if (!services) return skipped('access.ports', 'doctor.skipped.stopped');
  const out: CheckResult[] = [];
  for (const s of services) {
    for (const p of s.published ?? []) {
      if (s.service === PROXY) {
        if (p.address === '0.0.0.0' || p.address === '::') {
          out.push(
            problem(
              'access.ports',
              'warning',
              text('doctor.access.ports_all', { port: p.port }),
              readme(),
              s.service,
            ),
          );
        } else if (a.bindAddr !== null && p.address !== a.bindAddr) {
          out.push(
            problem(
              'access.ports',
              'failed',
              text('doctor.access.ports_proxy_address', {
                address: p.address,
                expected: a.bindAddr,
              }),
              readme(),
              s.service,
            ),
          );
        }
      } else if (!LOOPBACK.has(p.address)) {
        out.push(
          problem(
            'access.ports',
            'failed',
            text('doctor.access.ports_exposed', { address: p.address, port: p.port }),
            text('doctor.fix.readme', { section: 'Ports' }),
            s.service,
          ),
        );
      }
    }
  }
  if (out.length === 0) out.push(ok('access.ports', text('doctor.access.ports_ok')));
  return out;
}

function proxyCheck(services: readonly ServiceState[] | null | undefined): CheckResult {
  if (!services || services.length === 0) return skipped('access.proxy', 'doctor.skipped.stopped');
  const proxy = services.find((s) => s.service === PROXY);
  if (!proxy || proxy.state !== 'running') {
    return problem('access.proxy', 'failed', text('doctor.access.proxy_down'), readme());
  }
  if (proxy.health !== 'healthy') {
    return problem(
      'access.proxy',
      'warning',
      text('doctor.access.proxy_unhealthy', { health: proxy.health || '-' }),
      text('doctor.fix.logs', { service: PROXY }),
    );
  }
  return ok('access.proxy', text('doctor.access.proxy_ok'));
}

function tlsChecks(a: AccessFact, now: Date): CheckResult[] {
  const fix = t11();
  const out: CheckResult[] = [];
  if (!a.tls.dir) {
    out.push(problem('access.tls_files', 'failed', text('doctor.access.tls_no_dir'), fix));
  } else if (a.tls.missing.length > 0) {
    out.push(
      problem(
        'access.tls_files',
        'failed',
        text('doctor.tls.missing', { files: a.tls.missing.join(', '), dir: a.tls.dir }),
        fix,
      ),
    );
  } else {
    out.push(ok('access.tls_files', text('doctor.access.tls_files_ok', { dir: a.tls.dir })));
  }
  if (a.tls.certs.length === 0) out.push(skipped('access.tls_expiry', 'doctor.skipped.no_tls'));
  for (const cert of a.tls.certs) {
    if (cert.notAfter === null) {
      out.push(problem('access.tls_expiry', 'failed', text('doctor.tls.invalid'), fix, cert.name));
      continue;
    }
    const days = Math.floor((new Date(cert.notAfter).getTime() - now.getTime()) / DAY_MS);
    const params = { date: cert.notAfter.slice(0, 10), days: Math.max(days, 0) };
    if (days < 0)
      out.push(
        problem('access.tls_expiry', 'failed', text('doctor.tls.expired', params), fix, cert.name),
      );
    else if (days < ACCESS_TLS_WARNING_DAYS)
      out.push(
        problem('access.tls_expiry', 'warning', text('doctor.tls.soon', params), fix, cert.name),
      );
    else out.push(ok('access.tls_expiry', text('doctor.tls.ok', params), cert.name));
  }
  if (!a.hostname) {
    out.push(problem('access.tls_names', 'failed', text('doctor.access.no_hostname'), readme()));
  } else if (a.tls.unnamed === null) {
    out.push(skipped('access.tls_names', 'doctor.skipped.no_tls'));
  } else if (a.tls.unnamed.length > 0) {
    out.push(
      problem(
        'access.tls_names',
        'failed',
        text('doctor.access.tls_unnamed', { names: a.tls.unnamed.join(', ') }),
        fix,
      ),
    );
  } else {
    out.push(ok('access.tls_names', text('doctor.access.tls_names_ok', { name: a.hostname })));
  }
  return out;
}

function originCheck(a: AccessFact): CheckResult {
  const expected = expectedOrigin(a);
  if (expected === null) return skipped('access.public_origin', 'doctor.skipped.access_no_host');
  if (a.publicOrigin !== null && a.publicOrigin !== expected) {
    return problem(
      'access.public_origin',
      'failed',
      text('doctor.access.origin_wrong', { origin: a.publicOrigin, expected }),
      readme(),
    );
  }
  if (a.publicOrigin === null && a.webSignIn === 'github') {
    return problem(
      'access.public_origin',
      'failed',
      text('doctor.access.origin_missing', { expected }),
      readme(),
    );
  }
  return ok('access.public_origin', text('doctor.access.origin_ok', { origin: expected }));
}

function trustedProxyCheck(a: AccessFact): CheckResult {
  if (a.trustedProxy !== a.proxyIp) {
    return problem(
      'access.trusted_proxy',
      'failed',
      text('doctor.access.trusted_wrong', { expected: a.proxyIp }),
      readme(),
    );
  }
  return ok('access.trusted_proxy', text('doctor.access.trusted_ok', { address: a.proxyIp }));
}

export function accessChecks(f: OperatorFacts): CheckResult[] {
  const ids = [
    'access.tls_files',
    'access.tls_expiry',
    'access.tls_names',
    'access.public_origin',
    'access.trusted_proxy',
  ] as const;
  if (!f.envFile.exists || !f.access) {
    return [
      skipped('access.proxy', 'doctor.skipped.no_env'),
      ...ids.slice(0, 3).map((id) => skipped(id, 'doctor.skipped.no_env')),
      skipped('access.ports', 'doctor.skipped.no_env'),
      ...ids.slice(3).map((id) => skipped(id, 'doctor.skipped.no_env')),
    ];
  }
  const a = f.access;
  const services = f.docker ? f.services : undefined;
  if (!a.configured) {
    return [
      ok('access.proxy', text('doctor.access.off')),
      ...ids.slice(0, 3).map((id) => skipped(id, 'doctor.skipped.access_off')),
      ...[portsCheck(a, services)].flat(),
      ...ids.slice(3).map((id) => skipped(id, 'doctor.skipped.access_off')),
    ];
  }
  return [
    proxyCheck(services),
    ...tlsChecks(a, f.now),
    ...[portsCheck(a, services)].flat(),
    originCheck(a),
    trustedProxyCheck(a),
  ];
}
