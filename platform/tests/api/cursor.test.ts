import { describe, expect, it } from 'vitest';

import { ApiError } from '../../apps/api/src/errors/api-error.js';
import { decodeCursor, encodeCursor } from '../../apps/api/src/intents/cursor.js';

describe('intent page cursor', () => {
  it('round-trips a position', () => {
    const position = {
      createdAt: new Date('2026-09-27T01:02:03.456Z'),
      id: '0b8f4f3e-9d0e-4c3b-8a55-1f6a5c7d2e10',
    };
    expect(decodeCursor(encodeCursor(position))).toEqual(position);
  });

  it.each(['', 'bad', Buffer.from('{"c":"x","i":"y"}').toString('base64url')])(
    'refuses %j',
    (cursor) => {
      expect(() => decodeCursor(cursor)).toThrow(ApiError);
    },
  );
});
