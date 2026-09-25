// Autonomy caps and model routing (D-02 FR-03, design/D-07 section 4, QUESTIONS.md #17 and #18).
// Values come from `autonomy.max_by_risk` and `model_routing.allowed_provider_types`.
import type {
  AutonomyLevel,
  DataClass,
  ModelRef,
  RiskTier,
  ValidatedProjectConfig,
} from '@sdlc/contracts';

function allowedProviderTypes(config: ValidatedProjectConfig, dataClass: DataClass) {
  return config.model_routing.allowed_provider_types[dataClass];
}

/** The risk tier's cap; L0 when the data class may go to no model at all (`prohibited`). */
export function maxAutonomy(
  config: ValidatedProjectConfig,
  input: { riskTier: RiskTier; dataClass: DataClass },
): AutonomyLevel {
  if (allowedProviderTypes(config, input.dataClass).length === 0) return 'L0';
  return config.autonomy.max_by_risk[input.riskTier];
}

/** Models from the gateway's list whose provider type the data class allows. */
export function allowedModels(
  config: ValidatedProjectConfig,
  models: readonly ModelRef[],
  dataClass: DataClass,
): string[] {
  const allowed = allowedProviderTypes(config, dataClass);
  return models.filter((ref) => allowed.includes(ref.providerType)).map((ref) => ref.model);
}
