// Model gateway adapter: LiteLLM Proxy. See design/D-03 section 7.4, D-08 C03, ADR-M24.
export { GatewayError, type GatewayErrorCode } from './errors.js';
export { LiteLLMGateway, type LiteLLMGatewayOptions } from './gateway.js';
export {
  labelsFromTags,
  labelTags,
  modelsFromInfo,
  runKeyAlias,
  spendRecordFromRow,
  tenantTeamId,
  usdFromNumber,
} from './mapping.js';
