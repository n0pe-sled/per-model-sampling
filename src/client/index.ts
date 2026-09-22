import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the slots Context merge (ctx.slots) into this program.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import {
  SamplingPanel,
  type Modality,
  type NamespaceRow,
  type SamplingApi,
  type SaveOutcome,
  type SamplingSaveSpec,
  type SamplingSection,
  type ThinkingLevel,
} from './SamplingPanel.tsx'

/** Plugin namespace; holds per-model temperature entries only. */
const NAMESPACE = 'per-model-sampling'

/** Read one dotted-free path of plain objects off a section value. */
function pathValue(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const segment of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/**
 * Whether one model entry carries exactly the input modalities requested.
 *
 * `undefined` means "no declaration", which the entry may carry as an absent
 * key or as the empty list the config schema materializes — both read as no
 * answer during resolution, so both count as landed.
 */
function modalitiesEqual(actual: unknown, expected: readonly Modality[] | undefined): boolean {
  const declared = Array.isArray(actual)
    ? actual.filter((value): value is Modality => value === 'text' || value === 'image')
    : []
  if (expected === undefined) return declared.length === 0
  return declared.length === expected.length && expected.every(modality => declared.includes(modality))
}

/** Whether one model entry carries exactly the reasoning-effort declaration requested. */
function effortsEqual(
  actual: unknown,
  expected: false | Partial<Record<ThinkingLevel, string | null>> | undefined,
): boolean {
  if (expected === undefined) return actual === undefined
  if (expected === false) return actual === false
  if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) return false
  const record = actual as Record<string, unknown>
  for (const [level, value] of Object.entries(expected)) {
    if (record[level] !== value) return false
  }
  for (const key of Object.keys(record)) {
    if (!(key in expected)) return false
  }
  return true
}

/** Whether two entry lists carry the same provider/model/temperature facts. */
function entriesEqual(a: SamplingSection['entries'], b: SamplingSection['entries']): boolean {
  if (a.length !== b.length) return false
  return a.every((entry, index) => {
    const other = b[index]
    return other !== undefined
      && entry.provider === other.provider
      && entry.model === other.model
      && entry.temperature === other.temperature
  })
}

/** Replace (or drop) one model's temperature entry in the stored list. */
function upsertTemperature(
  entries: SamplingSection['entries'],
  provider: string,
  model: string,
  temperature: number | undefined,
): SamplingSection['entries'] {
  const kept = entries.filter(entry => !(entry.provider === provider && entry.model === model))
  return temperature === undefined
    ? kept
    : [...kept, { provider, model, temperature }]
}

/** Rebuild one models array with the target entry's reasoningEfforts replaced. */
function withEfforts(
  entry: Record<string, unknown>,
  efforts: false | Partial<Record<ThinkingLevel, string | null>> | undefined,
): Record<string, unknown> {
  if (efforts === undefined) {
    const { reasoningEfforts: _dropped, ...rest } = entry
    return rest
  }
  return { ...entry, reasoningEfforts: efforts }
}

/**
 * Rebuild one models array with the target entry's input modalities replaced.
 *
 * `undefined` removes the key rather than storing an empty list: resolution
 * reads `[]` as "no answer here" (`llm-pi-ai`'s `declaredInput`), so an empty
 * array and an absent key mean the same thing, and the absent one is what a
 * user layer should carry.
 */
function withInput(entry: Record<string, unknown>, input: readonly Modality[] | undefined): Record<string, unknown> {
  if (input === undefined) {
    const { input: _dropped, ...rest } = entry
    return rest
  }
  return { ...entry, input: [...input] }
}

export const inject = ['slots', 'settingsScope', 'connection']

/**
 * Register the Per-model sampling settings page.
 *
 * Two write targets, deliberately different:
 * - temperature lives in this plugin's own namespace and is applied by the
 *   node half's `agent/request` waterfall, because no adapter profile has a
 *   temperature field a plugin could set.
 * - the model declaration — `input` modalities and `reasoningEfforts` — is
 *   written into the owning adapter's own namespace (`llm-pi-ai`'s
 *   `providers.<route>.models[]`), because the attachment path, the composer
 *   picker, and the resolver read the profile, not plugin state. The settings
 *   path mutator cannot address an array element (a numeric path replaces the
 *   array with an object), so the whole models array is rebuilt from the
 *   RAW user layer — never from the resolved value, whose materialized
 *   defaults (an `input: []` on every entry) must not be persisted.
 */
export function apply(ctx: ClientContext): void {
  const scope = ctx.settingsScope.bind<SamplingSection>({ namespace: NAMESPACE })
  const connection = ctx.get('connection') as ConnectionHandle
  // Bound to the local wire contract so this half's writes are checked here,
  // where the host's published contract types resolve to `any` (see
  // SamplingPanel's ProviderRow note).
  const api = connection.api as SamplingApi
  const describe = ctx.settingsScope.describe()

  const save = async (spec: SamplingSaveSpec): Promise<SaveOutcome> => {
    // Temperature first: the plugin namespace write can fail independently of
    // the adapter namespace, so report which half landed.
    const nextEntries = upsertTemperature(
      scope.getSnapshot().value?.entries ?? [],
      spec.provider,
      spec.model,
      spec.temperature,
    )
    try {
      await scope.set('entries', nextEntries)
    } catch (error) {
      return { status: 'error', message: messageOf(error) }
    }
    if (!entriesEqual(scope.getSnapshot().value?.entries ?? [], nextEntries)) {
      return { status: 'not-applied' }
    }

    if (spec.efforts === undefined && spec.input === undefined && spec.modelIndex < 0) return { status: 'saved' }
    if (spec.modelIndex < 0) {
      return { status: 'partial', message: 'Temperature saved. The model declaration needs a model entry in this provider\'s settings; add the model on the Models page first.' }
    }

    const namespaces = (describe.getSnapshot().view?.namespaces ?? []) as readonly NamespaceRow[]
    const view = namespaces.find(candidate => candidate.ns === spec.settingsNs)
    if (view === undefined) {
      return { status: 'partial', message: 'Temperature saved. The provider\'s settings namespace is not available to this browser, so the model declaration was not written.' }
    }
    const userProfile = pathValue(view.user, spec.settingsPath)
    const userModels = pathValue(userProfile, ['models'])
    if (!Array.isArray(userModels)) {
      return { status: 'partial', message: 'Temperature saved. This provider has no user-owned models list to edit; declare the model on the Models page, then set its input modalities and reasoning efforts here.' }
    }
    const target = userModels[spec.modelIndex]
    if (typeof target !== 'object' || target === null) {
      return { status: 'partial', message: 'Temperature saved. The model row moved since this page loaded; reload and try again.' }
    }
    const nextModels = userModels.map((entry, index) =>
      index === spec.modelIndex
        ? withInput(withEfforts(target as Record<string, unknown>, spec.efforts), spec.input)
        : entry)
    const response = await api.settings.mutate({
      ns: spec.settingsNs,
      ops: [{ op: 'set', path: [...spec.settingsPath, 'models'], value: nextModels }],
      ...spec.revision === undefined ? {} : { expectedRevision: spec.revision },
    })
    if (!response.result.ok) {
      return { status: 'partial', message: `Temperature saved. The model declaration was refused: ${response.result.error.message}` }
    }
    // The host answers with its complete namespace view (schema, applies,
    // secrets); this page reads three fields of it. Hand the answer straight
    // back so the mirror folds the authoritative revision.
    const answered = response.result.value as unknown as Parameters<SettingsDescribeFace['acceptView']>[0]
    describe.acceptView(answered)
    const afterNamespaces = (describe.getSnapshot().view?.namespaces ?? []) as readonly NamespaceRow[]
    const after = afterNamespaces.find(candidate => candidate.ns === spec.settingsNs)
    const afterModels = pathValue(after?.value, [...spec.settingsPath, 'models'])
    const afterEntry = Array.isArray(afterModels) ? afterModels[spec.modelIndex] : undefined
    const afterRecord = typeof afterEntry === 'object' && afterEntry !== null
      ? afterEntry as Record<string, unknown>
      : undefined
    if (!effortsEqual(afterRecord?.['reasoningEfforts'], spec.efforts)) {
      return { status: 'partial', message: 'Temperature saved, but the reasoning-effort write did not land; reload and check the Models page.' }
    }
    if (!modalitiesEqual(afterRecord?.['input'], spec.input)) {
      return { status: 'partial', message: 'Temperature saved, but the input-modality write did not land; reload and check the Models page.' }
    }
    return { status: 'saved' }
  }

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'per-model-sampling',
    // The settings nav sorts by this number alone. Models sits at 10 and Logins
    // at 11, and they are adjacent, so the slot between them is the fraction.
    // Moving either neighbour means revisiting this value.
    order: 10.5,
    label: 'Model Settings',
    inject: () => ({
      hooks: {
        sampling: scope,
        settingsDocument: describe,
      },
      api,
      ensureDocument: () => describe.ensure(),
      save,
    }),
  }, SamplingPanel))
}

/** Human text for a rejected write. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type {
  SaveOutcome,
  SamplingSaveSpec,
  SamplingSection,
} from './SamplingPanel.tsx'
