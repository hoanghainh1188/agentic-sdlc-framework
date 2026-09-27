// Opaque page cursor: the (created_at, id) of the last intent of a page, base64url JSON.
import type { IntentPosition } from '@sdlc/core';
import { isUuid } from '@sdlc/core';

import { ApiError } from '../errors/api-error.js';

export function encodeCursor(position: IntentPosition): string {
  return Buffer.from(
    JSON.stringify({ c: position.createdAt.toISOString(), i: position.id }),
    'utf8',
  ).toString('base64url');
}

export function decodeCursor(cursor: string): IntentPosition {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (typeof value === 'object' && value !== null) {
      const { c, i } = value as { c?: unknown; i?: unknown };
      const createdAt = typeof c === 'string' ? new Date(c) : undefined;
      if (createdAt && !Number.isNaN(createdAt.getTime()) && isUuid(i)) return { createdAt, id: i };
    }
  } catch {
    // Falls through to the error below.
  }
  throw new ApiError(400, 'invalid_request', undefined, [
    { path: 'query.cursor', issue: 'invalid_format' },
  ]);
}
