// Comment commands on the Git host (D-02 FR-21, D-08 B06 AC2, design/ADR-M27 section 2.3).
//
//   /approve G<n>
//   /reject G<n> [<reason_code>] <reason>
//   /request-changes G<n> [<reason_code>] <reason>
//
// Only the first non-empty line of a comment is read; text quoted or written further down is
// never taken as a command. The reason text stays in the comment on the Git host: the parser
// returns codes only, and the decision stores the comment URL as `reason_ref` (ADR-M20).
// Other slash words (`/label`, later `/ack`, `/kill`) are not ours and are ignored.
import { GATE_CODES, GATE_REASON_CODES, type GateCode, type GateReasonCode } from '@sdlc/contracts';

import type { CommandDecision } from './gate-command.js';

/** The command words and the decision each one sends. */
export const COMMENT_VERBS = {
  approve: 'approve',
  reject: 'reject',
  'request-changes': 'request_changes',
} as const satisfies Readonly<Record<string, CommandDecision>>;
export type CommentVerb = keyof typeof COMMENT_VERBS;

/** Why a command could not be read. Each has a reply `comment.reply.syntax_<problem>`. */
export const COMMENT_SYNTAX_PROBLEMS = [
  'gate_missing',
  'gate_invalid',
  'unexpected_text',
  'reason_missing',
] as const;
export type CommentSyntaxProblem = (typeof COMMENT_SYNTAX_PROBLEMS)[number];

export type ParsedComment =
  /** Not a command of the platform: no reply, no receipt. */
  | { readonly kind: 'none' }
  | {
      readonly kind: 'invalid';
      readonly verb: CommentVerb;
      readonly problem: CommentSyntaxProblem;
    }
  | {
      readonly kind: 'gate_decision';
      readonly verb: CommentVerb;
      readonly gate: GateCode;
      readonly decision: CommandDecision;
      /** Null for `/approve`; `other` when a reject or request-changes names no code. */
      readonly reasonCode: GateReasonCode | null;
    };

const COMMAND_LINE = /^\/([A-Za-z][A-Za-z-]*)(?:[ \t]+(.*))?$/;
const GATE = /^[Gg]([0-9]+)$/;

function isVerb(word: string): word is CommentVerb {
  return Object.hasOwn(COMMENT_VERBS, word);
}

/** A reason code as the first word of the reason: `spec_unclear` or `spec-unclear`, any case. */
function reasonCodeOf(word: string | undefined): GateReasonCode | undefined {
  if (word === undefined) return undefined;
  const code = word.toLowerCase().replaceAll('-', '_');
  return (GATE_REASON_CODES as readonly string[]).includes(code)
    ? (code as GateReasonCode)
    : undefined;
}

export function parseCommentCommand(body: string): ParsedComment {
  const lines = body.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  const first = lines.findIndex((line) => line.trim() !== '');
  if (first === -1) return { kind: 'none' };
  const match = COMMAND_LINE.exec(lines[first]!.trim());
  if (!match) return { kind: 'none' };
  const verb = match[1]!.toLowerCase();
  if (!isVerb(verb)) return { kind: 'none' };

  const words = (match[2] ?? '').split(/[ \t]+/).filter((word) => word !== '');
  const [gateWord, ...rest] = words;
  if (gateWord === undefined) return { kind: 'invalid', verb, problem: 'gate_missing' };
  const gateMatch = GATE.exec(gateWord);
  const gate = gateMatch ? `G${String(Number(gateMatch[1]))}` : undefined;
  if (gate === undefined || !(GATE_CODES as readonly string[]).includes(gate)) {
    return { kind: 'invalid', verb, problem: 'gate_invalid' };
  }
  const decision = COMMENT_VERBS[verb];

  if (decision === 'approve') {
    // Only the gate: "/approve G3 if the tests pass" must not pass as a plain approval.
    if (rest.length > 0) return { kind: 'invalid', verb, problem: 'unexpected_text' };
    return { kind: 'gate_decision', verb, gate: gate as GateCode, decision, reasonCode: null };
  }

  const code = reasonCodeOf(rest[0]);
  const reasonWords = code === undefined ? rest : rest.slice(1);
  const moreLines = lines.slice(first + 1).some((line) => line.trim() !== '');
  if (reasonWords.length === 0 && !moreLines) {
    return { kind: 'invalid', verb, problem: 'reason_missing' };
  }
  return {
    kind: 'gate_decision',
    verb,
    gate: gate as GateCode,
    decision,
    reasonCode: code ?? 'other',
  };
}
