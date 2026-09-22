import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
// Type-only: pulls the dsh-agent event map (agent/request) and the
// dsh-settings Context merge (ctx.settings) into this program.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-settings'

export const name = 'per-model-sampling'
export const inject = ['settings']

/** One model's declared temperature, keyed by provider route and model id. */
export interface PerModelEntry {
  /** Provider route the entry applies to. */
  provider: string
  /** Model id the entry applies to. */
  model: string
  /** Temperature sent with this model's requests; absent means "send no temperature". */
  temperature?: number
}

/** Plugin settings namespace section. */
export interface SettingsSection {
  entries: PerModelEntry[]
}

const NAMESPACE: SettingsNamespace = settingsNamespace('per-model-sampling')

const settingsSchema: z<SettingsSection> = Schema.object({
  entries: Schema.array(Schema.object({
    provider: Schema.string().required(),
    model: Schema.string().required(),
    temperature: Schema.number().min(0).max(2),
  })).default([]),
})

/**
 * Return the config without a temperature field. The proposal the loop hands
 * plugins is deep-frozen, so removal is a rebuild, never a delete.
 */
function withoutTemperature(config: LlmCallConfig): LlmCallConfig {
  const { temperature: _dropped, ...rest } = config
  return rest
}

/**
 * Decide one proposal's temperature from the configured entries.
 *
 * The lookup keys on the proposal's own provider and model every time,
 * because the loop's request proposal carries whatever the previous step set
 * (`requestProposal` only strips adapter-supplied reasoningEffort/maxTokens).
 * Without re-deciding, a temperature configured for model A rides into a
 * mid-session switch to model B, and an unset value sticks the same way.
 *
 * Matching entry sets its temperature; a matching entry without one, or no
 * entry at all, drops the field. A model not in the table sends nothing.
 */
export function applyTemperature(
  entries: readonly PerModelEntry[],
  config: LlmCallConfig,
): LlmCallConfig {
  const entry = entries.find(candidate =>
    candidate.provider === config.provider && candidate.model === config.model)
  if (entry === undefined || entry.temperature === undefined) {
    return config.temperature === undefined ? config : withoutTemperature(config)
  }
  return { ...config, temperature: entry.temperature }
}

/**
 * Register the per-model temperature producer.
 *
 * The loop seeds its proposal from the logged session header, dispatches
 * `agent/request`, and only then runs `llm.prepareCall()`. This listener sits
 * inside that waterfall, so the temperature it returns is what the adapters
 * map onto the wire (`llm-pi-ai` maps `options.temperature` directly).
 */
export function apply(ctx: Context): void {
  const scope = ctx.settings.register(NAMESPACE, settingsSchema)
  ctx.on('agent/request', async (_payload, next): Promise<LlmCallConfig> => {
    const config = await next()
    return applyTemperature(scope.get().entries, config)
  })
}
