// Errors of the LiteLLM adapter. The message holds the method, the path without its query, and the
// HTTP status only: never a request or response body (LiteLLM error texts can quote a key), never
// the master key or a virtual key (D-08 A04 AC3 applies to every secret).

export type GatewayErrorCode =
  /** LiteLLM answered with an HTTP error status. */
  | 'http_error'
  /** No answer: connection refused, DNS, timeout. */
  | 'unreachable'
  /** The answer is not the JSON shape this adapter expects (a LiteLLM version change). */
  | 'unexpected_response'
  /** An input the adapter refuses before calling LiteLLM; `field` says which. */
  | 'invalid_input';

export class GatewayError extends Error {
  override readonly name = 'GatewayError';

  constructor(
    readonly code: GatewayErrorCode,
    message: string,
    readonly status?: number,
    readonly field?: string,
  ) {
    super(message);
  }
}
