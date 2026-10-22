// Refusals of the tool register (task X04, design/ADR-M69 §2.2–§2.3). Like `AgentRegisterError`,
// they carry a stable `code`; the CLI and the API render codes through the message catalog
// (`tool_register.error.<code>`).
import { t, type MessageKey } from '@sdlc/messages';

/** G4's refusals of a register tool, in the order G4 checks them (ADR-M69 §2.3). */
export const TOOL_RUN_REFUSALS = [
  'tool_not_found',
  'tool_not_allowed_for_agent',
  'tool_not_active',
  'tool_data_class_not_allowed',
  'tool_transport_not_supported',
] as const;
export type ToolRunRefusal = (typeof TOOL_RUN_REFUSALS)[number];

export type ToolRegisterErrorCode =
  /** A field does not have the expected format; `field` names it. */
  | 'invalid_input'
  /** The owner is not an active user of the tenant. */
  | 'owner_not_active'
  /** The tool key is taken in this tenant, also by a retired tool. */
  | 'tool_exists'
  /** The status move is not one of `tool_status` (ADR-M31 §2.3). */
  | 'status_move_not_allowed'
  /** The tool is retired: nothing changes any more. */
  | 'tool_retired'
  /** A configuration change needs the tool `proposed` or `suspended`. */
  | 'config_change_not_allowed'
  /** A configuration change needs a new version label. */
  | 'version_unchanged'
  /** Suspend, quarantine and retire need a reason code. */
  | 'reason_required'
  /** Activation of an `http` tool needs its image digest (R038). */
  | 'image_not_pinned'
  /** A recertification date in the future, or before the last one. */
  | 'recertification_date_invalid'
  /** The person may not do this. */
  | 'not_permitted'
  /** The person does not fill the capacity, or the capacity does not approve this step. */
  | 'not_an_approver'
  /** The person, or someone in the same capacity, already approved this round. */
  | 'approval_duplicate'
  | ToolRunRefusal;

export class ToolRegisterError extends Error {
  override readonly name = 'ToolRegisterError';

  constructor(
    readonly code: ToolRegisterErrorCode,
    message: string,
    /** The field that failed (`invalid_input` only). */
    readonly field?: string,
    /** The tool a G4 refusal is about. */
    readonly toolKey?: string,
  ) {
    super(message);
  }
}

/** Catalog keys of the refusals (NFR-08). Parameters: `key` (the tool key) and `field`. */
export const TOOL_REGISTER_ERROR_MESSAGES = {
  invalid_input: 'tool_register.error.invalid_input',
  owner_not_active: 'tool_register.error.owner_not_active',
  tool_exists: 'tool_register.error.tool_exists',
  status_move_not_allowed: 'tool_register.error.status_move_not_allowed',
  tool_retired: 'tool_register.error.tool_retired',
  config_change_not_allowed: 'tool_register.error.config_change_not_allowed',
  version_unchanged: 'tool_register.error.version_unchanged',
  reason_required: 'tool_register.error.reason_required',
  image_not_pinned: 'tool_register.error.image_not_pinned',
  recertification_date_invalid: 'tool_register.error.recertification_date_invalid',
  not_permitted: 'tool_register.error.not_permitted',
  not_an_approver: 'tool_register.error.not_an_approver',
  approval_duplicate: 'tool_register.error.approval_duplicate',
  tool_not_found: 'tool_register.error.tool_not_found',
  tool_not_allowed_for_agent: 'tool_register.error.tool_not_allowed_for_agent',
  tool_not_active: 'tool_register.error.tool_not_active',
  tool_data_class_not_allowed: 'tool_register.error.tool_data_class_not_allowed',
  tool_transport_not_supported: 'tool_register.error.tool_transport_not_supported',
} as const satisfies Record<ToolRegisterErrorCode, MessageKey>;

export function isToolRegisterErrorCode(code: string): code is ToolRegisterErrorCode {
  return Object.hasOwn(TOOL_REGISTER_ERROR_MESSAGES, code);
}

/** The text of a refusal. `toolKey` names the tool in the text; missing values render as `-`. */
export function toolRegisterErrorMessage(
  error: ToolRegisterError,
  toolKey = '-',
  locale?: string,
): string {
  return t(
    TOOL_REGISTER_ERROR_MESSAGES[error.code],
    { key: toolKey, field: error.field ?? '-' },
    locale,
  );
}
