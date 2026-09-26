// Task A11: the TLS tests need OpenSSL 3.x. LibreSSL (macOS /usr/bin/openssl) is refused with a
// clear message instead of certificates that fail later with misleading errors.
import { describe, expect, it } from 'vitest';

import { opensslVersionProblem } from './throwaway-ca';

describe('openssl version check of the throw-away CA helper', () => {
  it.each([
    'OpenSSL 3.0.13 30 Jan 2024 (Library: OpenSSL 3.0.13 30 Jan 2024)',
    'OpenSSL 3.6.4 25 Aug 2026 (Library: OpenSSL 3.6.4 25 Aug 2026)\n',
    'OpenSSL 4.0.0 1 Jan 2027',
  ])('accepts %s', (output) => {
    expect(opensslVersionProblem(output, '/opt/homebrew/bin/openssl')).toBeUndefined();
  });

  it.each(['LibreSSL 3.3.6', 'OpenSSL 1.1.1w  11 Sep 2023', ''])('refuses "%s"', (output) => {
    const problem = opensslVersionProblem(output, '/usr/bin/openssl');
    expect(problem).toMatch(/need OpenSSL 3\.x/);
    expect(problem).toContain('/usr/bin/openssl');
    expect(problem).toMatch(/first in PATH/);
  });
});
