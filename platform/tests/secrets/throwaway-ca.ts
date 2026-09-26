// Throw-away certificate authorities for the TLS tests of @sdlc/secrets (QUESTIONS #20).
// Created with the openssl CLI in a temp folder and deleted afterwards. The real internal CA and
// the TLS listener come in task A10. `openssl ca` is used for server certificates because it
// sets explicit start and end dates (an expired certificate) on OpenSSL 3.0 (CI) and later.
// OpenSSL 3.x is required: LibreSSL (the macOS default /usr/bin/openssl) makes different
// certificates, and the TLS tests then fail with misleading errors (task A11).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ServerCert {
  readonly key: Buffer;
  readonly cert: Buffer;
}

export class ThrowawayCa {
  readonly dir: string;
  readonly certFile: string;

  private constructor(dir: string) {
    this.dir = dir;
    this.certFile = path.join(dir, 'ca.pem');
  }

  static create(name: string): ThrowawayCa {
    requireOpenssl3();
    const ca = new ThrowawayCa(fs.mkdtempSync(path.join(os.tmpdir(), `sdlc-ca-${name}-`)));
    ca.#openssl(
      'req',
      '-x509',
      ...EC_KEY,
      '-nodes',
      '-days',
      '2',
      '-keyout',
      ca.#file('ca.key'),
      '-out',
      ca.certFile,
      '-subj',
      `/CN=Throw-away test CA ${name}`,
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
    );
    fs.writeFileSync(ca.#file('index.txt'), '');
    fs.writeFileSync(ca.#file('serial'), '01\n');
    fs.writeFileSync(ca.#file('ca.cnf'), caConfig(ca.dir));
    return ca;
  }

  /** A server certificate for `hosts` (DNS names or IPs), valid between the two dates. */
  issue(hosts: readonly string[], notBefore: Date, notAfter: Date): ServerCert {
    const id = `server-${fs.readFileSync(this.#file('serial'), 'utf8').trim()}`;
    const san = hosts.map((h) => (/^[\d.]+$/.test(h) ? `IP:${h}` : `DNS:${h}`)).join(',');
    fs.writeFileSync(
      this.#file(`${id}.ext`),
      `subjectAltName=${san}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`,
    );
    this.#openssl(
      'req',
      '-new',
      ...EC_KEY,
      '-nodes',
      '-keyout',
      this.#file(`${id}.key`),
      '-out',
      this.#file(`${id}.csr`),
      '-subj',
      '/CN=openbao-test',
    );
    this.#openssl(
      'ca',
      '-batch',
      '-config',
      this.#file('ca.cnf'),
      '-notext',
      '-startdate',
      asn1(notBefore),
      '-enddate',
      asn1(notAfter),
      '-extfile',
      this.#file(`${id}.ext`),
      '-in',
      this.#file(`${id}.csr`),
      '-out',
      this.#file(`${id}.pem`),
    );
    return {
      key: fs.readFileSync(this.#file(`${id}.key`)),
      cert: fs.readFileSync(this.#file(`${id}.pem`)),
    };
  }

  remove(): void {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  #file(name: string): string {
    return path.join(this.dir, name);
  }

  #openssl(...args: string[]): void {
    execFileSync('openssl', args, { cwd: this.dir, stdio: ['ignore', 'ignore', 'pipe'] });
  }
}

/**
 * Returns an error message when `openssl version` output is not OpenSSL 3.x or later,
 * otherwise undefined. `found` is the path of the openssl binary, for the message.
 */
export function opensslVersionProblem(versionOutput: string, found: string): string | undefined {
  const major = /^OpenSSL (\d+)\./.exec(versionOutput.trim())?.[1];
  if (major !== undefined && Number(major) >= 3) return undefined;
  return (
    `The TLS tests need OpenSSL 3.x, but "${found}" is "${versionOutput.trim() || 'unknown'}". ` +
    'Put OpenSSL 3 first in PATH, for example on macOS: brew install openssl@3 && ' +
    'export PATH="$(brew --prefix openssl@3)/bin:$PATH"'
  );
}

let opensslChecked = false;

function requireOpenssl3(): void {
  if (opensslChecked) return;
  let version = '';
  let found = 'openssl';
  try {
    found = execFileSync('sh', ['-c', 'command -v openssl'], { encoding: 'utf8' }).trim();
    version = execFileSync('openssl', ['version'], { encoding: 'utf8' });
  } catch {
    // Not installed: reported below.
  }
  const problem = opensslVersionProblem(version, found);
  if (problem) throw new Error(problem);
  opensslChecked = true;
}

const EC_KEY = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1'];

function asn1(date: Date): string {
  return `${date.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;
}

function caConfig(dir: string): string {
  return `[ ca ]
default_ca = test_ca
[ test_ca ]
database = ${dir}/index.txt
new_certs_dir = ${dir}
certificate = ${dir}/ca.pem
private_key = ${dir}/ca.key
serial = ${dir}/serial
default_md = sha256
policy = any
unique_subject = no
copy_extensions = none
[ any ]
commonName = supplied
`;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
