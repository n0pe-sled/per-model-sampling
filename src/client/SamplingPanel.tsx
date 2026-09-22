import { useEffect, useState } from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Wire view of one configurable provider, mirroring the host's
 * `ConfigurableProviderView`.
 *
 * The host's published contracts resolve to `any` outside the harness repo's
 * source-level `paths` facade (their `.d.ts` import relatively with `.ts`
 * extensions), and this plugin repo deliberately carries no facade. Declaring
 * the two shapes this page consumes keeps its own logic checked here instead
 * of silently untyped.
 */
export interface ProviderRow {
  provider: string
  displayName: string
  settingsNs: string
  settingsPath: string[]
  active: boolean
  declared?: boolean
}

/** One namespace as the settings wire reports it. */
export interface NamespaceRow {
  ns: string
  value?: unknown
  user?: unknown
  revision: number
}

/** Unary wire answer. */
export type WireResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { message: string } }

/** The two wire calls this page makes. */
export interface SamplingApi {
  llm: {
    providers(payload: Record<string, never>): Promise<{ result: WireResult<{ providers: ProviderRow[] }> }>
  }
  settings: {
    mutate(payload: {
      ns: string
      ops: { op: 'set'; path: string[]; value: unknown }[]
      expectedRevision?: number
    }): Promise<{ result: WireResult<NamespaceRow> }>
  }
}

/** Thinking levels the pi-ai profile schema accepts as reasoningEffort keys. */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Levels a user may offer, beyond the off switch. */
const LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

type OfferedLevel = (typeof LEVELS)[number]

/**
 * Request modalities a model entry may declare, in offer order.
 *
 * This mirrors `llm-pi-ai`'s `MODALITIES` (`catalog.ts`), which is the set
 * `PiAiModelProfile.input` accepts. There is deliberately no output half: pi-ai's
 * `Model` type carries `input: ("text" | "image")[]` and no output field at all,
 * and the harness's `LlmModelInfo` reports only `inputModalities`. A control for
 * output modalities would write a key nothing reads.
 */
const MODALITIES = ['text', 'image'] as const

/** One request modality a model entry may declare. */
export type Modality = (typeof MODALITIES)[number]

/** One model's declared temperature, keyed by provider route and model id. */
export interface PerModelEntry {
  provider: string
  model: string
  temperature?: number
}

/** Plugin settings namespace section. */
export interface SamplingSection {
  entries: PerModelEntry[]
}

export type SaveOutcome =
  | { status: 'saved' }
  | { status: 'not-applied' }
  | { status: 'partial'; message: string }
  | { status: 'error'; message: string }

/** One save request, fully resolved by the panel. */
export interface SamplingSaveSpec {
  provider: string
  model: string
  /** undefined clears the entry (the model then sends no temperature). */
  temperature: number | undefined
  /**
   * false declares a non-reasoning model; a dict declares the offered levels
   * and their wire spellings; undefined removes the field (inherit or absent).
   */
  efforts: false | Partial<Record<ThinkingLevel, string | null>> | undefined
  /**
   * Request modalities this model accepts; undefined removes the field, which
   * keeps the installed catalog entry's list and then the route's `defaultInput`.
   * Never empty: `[]` describes a model that accepts nothing, so an empty
   * selection is the absence of a declaration rather than a stored value.
   */
  input: Modality[] | undefined
  settingsNs: string
  settingsPath: readonly string[]
  modelIndex: number
  revision: number | undefined
}

export interface SamplingPanelInjected {
  hooks: {
    sampling: SettingsScope<SamplingSection>
    settingsDocument: SettingsDescribeFace
  }
  api: SamplingApi
  /** Idempotent first-use read of the shared settings mirror. */
  ensureDocument(): Promise<void>
  save(spec: SamplingSaveSpec): Promise<SaveOutcome>
}

export type SamplingPanelProps = PropsRuntime<'settings.section'> & InjectFace<SamplingPanelInjected>

const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
    padding: '16px 20px',
    maxWidth: '720px',
  } as const,
  title: {
    margin: 0,
    fontSize: '15px',
    fontWeight: 600,
    color: 'var(--dsw-alias-label-primary)',
  } as const,
  copy: {
    margin: 0,
    fontSize: '12px',
    lineHeight: 1.5,
    color: 'var(--dsw-alias-label-tertiary)',
  } as const,
  grid: {
    display: 'grid',
    gridTemplateColumns: 'minmax(150px, 210px) minmax(260px, 1fr)',
    gap: '12px 16px',
    alignItems: 'center',
    padding: '14px',
    background: 'var(--dsw-alias-bg-layer-0)',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '10px',
  } as const,
  label: {
    fontSize: '13px',
    fontWeight: 500,
    color: 'var(--dsw-alias-label-secondary)',
  } as const,
  input: {
    width: '100%',
    padding: '8px 10px',
    boxSizing: 'border-box',
    fontSize: '13px',
    color: 'var(--dsw-alias-label-primary)',
    background: 'var(--dsw-alias-bg-layer-1)',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '7px',
  } as const,
  effortGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: '10px 14px',
    padding: '14px',
    background: 'var(--dsw-alias-bg-layer-0)',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '10px',
  } as const,
  modalityGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: '10px 14px',
    padding: '14px',
    background: 'var(--dsw-alias-bg-layer-0)',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '10px',
  } as const,
  effortCell: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  } as const,
  effortRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  } as const,
  checkboxLabel: {
    fontSize: '13px',
    color: 'var(--dsw-alias-label-secondary)',
  } as const,
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  } as const,
  button: {
    padding: '7px 14px',
    fontSize: '13px',
    border: 'none',
    borderRadius: '6px',
    color: 'var(--dsw-alias-label-primary-foreground)',
    background: 'var(--dsw-alias-button-primary-fill)',
    cursor: 'pointer',
  } as const,
  disabled: {
    opacity: 0.45,
    cursor: 'not-allowed',
  } as const,
  status: {
    margin: 0,
    fontSize: '12px',
    color: 'var(--dsw-alias-label-secondary)',
  } as const,
  error: {
    margin: 0,
    fontSize: '12px',
    color: 'var(--dsw-alias-interactive-bg-hover-danger)',
  } as const,
}

/** One model as the settings mirror shows it (schema-resolved, for display). */
interface ModelView {
  id: string
  name?: string
  input?: unknown
  reasoningEfforts?: unknown
}

/** The declared modalities of one raw model entry, or undefined for "no answer". */
function modalitiesOf(value: unknown): Modality[] | undefined {
  if (!Array.isArray(value)) return undefined
  const declared = MODALITIES.filter(modality => value.includes(modality))
  // Empty means the same as absent: a model accepting nothing could serve no
  // request, so an empty list is read as no declaration at all.
  return declared.length === 0 ? undefined : declared
}

/** Whether two modality lists state the same declaration. */
function modalitiesEqual(a: Modality[] | undefined, b: Modality[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.length === b.length && a.every((modality, index) => modality === b[index])
}

/** Read one plain-object path off a section value. */
function pathValue(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const segment of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** The models list of one provider's resolved profile. */
function modelsOf(profile: unknown): ModelView[] {
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) return []
  const models = (profile as Record<string, unknown>)['models']
  if (!Array.isArray(models)) return []
  return models.filter((entry): entry is ModelView =>
    typeof entry === 'object' && entry !== null && typeof (entry as Record<string, unknown>)['id'] === 'string')
}

/** The stored temperature for one model, from the plugin namespace. */
function temperatureOf(section: SamplingSection | undefined, provider: string, model: string): number | undefined {
  return section?.entries.find(entry => entry.provider === provider && entry.model === model)?.temperature
}

interface EffortsDraft {
  off: boolean
  levels: Record<OfferedLevel, { enabled: boolean; text: string }>
}

function emptyEffortsDraft(): EffortsDraft {
  const levels = {} as Record<OfferedLevel, { enabled: boolean; text: string }>
  for (const level of LEVELS) levels[level] = { enabled: false, text: '' }
  return { off: false, levels }
}

function effortsDraftOf(value: unknown): EffortsDraft {
  const draft = emptyEffortsDraft()
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return draft
  const record = value as Record<string, unknown>
  draft.off = 'off' in record
  for (const level of LEVELS) {
    const wire = record[level]
    if (typeof wire === 'string') draft.levels[level] = { enabled: true, text: wire }
  }
  return draft
}

function buildEfforts(draft: EffortsDraft): false | Partial<Record<ThinkingLevel, string | null>> | undefined {
  const checked = LEVELS.filter(level => draft.levels[level].enabled)
  if (checked.length === 0) return draft.off ? false : undefined
  const dict: Partial<Record<ThinkingLevel, string | null>> = {}
  if (draft.off) dict.off = ''
  for (const level of checked) {
    const text = draft.levels[level].text.trim()
    dict[level] = text === '' ? level : text
  }
  return dict
}

/** Whether the stored declaration equals the draft's intent (for dirty checks). */
function effortsMatch(draft: EffortsDraft, stored: unknown): boolean {
  const intent = buildEfforts(draft)
  if (intent === undefined) return stored === undefined
  if (intent === false) return stored === false
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return false
  const record = stored as Record<string, unknown>
  for (const [level, value] of Object.entries(intent)) {
    if (record[level] !== value) return false
  }
  for (const key of Object.keys(record)) {
    if (!(key in intent)) return false
  }
  return true
}

export function SamplingPanel(props: SamplingPanelProps) {
  const sampling = props.useSampling(snapshot => snapshot)
  const document = props.useSettingsDocument(snapshot => snapshot)
  const [providers, setProviders] = useState<ProviderRow[] | undefined>(undefined)
  const [providerError, setProviderError] = useState<string | undefined>(undefined)
  const [selectedProvider, setSelectedProvider] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [temperatureText, setTemperatureText] = useState('')
  const [efforts, setEfforts] = useState<EffortsDraft>(emptyEffortsDraft)
  const [modalities, setModalities] = useState<Modality[] | undefined>(undefined)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null)

  useEffect(() => {
    let cancelled = false
    // The mirror is shared, and another settings section may already have it;
    // ensure() is the idempotent first-use read for whichever section opens first.
    void props.ensureDocument()
    void props.api.llm.providers({}).then((response) => {
      if (cancelled) return
      if (!response.result.ok) {
        setProviderError(response.result.error.message)
        return
      }
      setProviders(response.result.value.providers.filter(row => row.settingsNs !== ''))
    }).catch((error: unknown) => {
      if (!cancelled) setProviderError(error instanceof Error ? error.message : String(error))
    })
    return () => { cancelled = true }
  }, [])

  const providerView = providers?.find(row => row.provider === selectedProvider)
  const namespaces = (document.view?.namespaces ?? []) as readonly NamespaceRow[]
  const namespaceView = namespaces.find(row => row.ns === providerView?.settingsNs)
  const profile = pathValue(namespaceView?.value, providerView?.settingsPath ?? [])
  const models = modelsOf(profile)
  const modelProfile = models.find(model => model.id === selectedModel)
  const userProfile = pathValue(namespaceView?.user, providerView?.settingsPath ?? [])
  const userModels = pathValue(userProfile, ['models'])
  const modelIndex = Array.isArray(userModels)
    ? userModels.findIndex(entry =>
      typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>)['id'] === selectedModel)
    : -1
  const userEntry = Array.isArray(userModels) && modelIndex >= 0 ? userModels[modelIndex] : undefined
  // What this model accepts today: the resolved profile, which is the entry's
  // own list, else the installed catalog's, else the route's `defaultInput`.
  const effectiveInput = modalitiesOf(modelProfile?.input)
  // What the user layer declares. The resolved list cannot answer this: an
  // absent `input` resolves to the route default, so a model inheriting
  // `[text]` looks identical to one declaring it.
  const storedInput = modalitiesOf(
    typeof userEntry === 'object' && userEntry !== null
      ? (userEntry as Record<string, unknown>)['input']
      : undefined,
  )
  const storedTemperature = temperatureOf(sampling.value, selectedProvider, selectedModel)

  // Keep the selection valid as the directory or the mirror changes.
  useEffect(() => {
    if (providers === undefined || providers.length === 0) return
    const current = providers.find(row => row.provider === selectedProvider)
    if (current === undefined) {
      setSelectedProvider(providers[0]!.provider)
      return
    }
    if (models.length === 0) {
      // The provider serves no models yet; drop a stale id from another route
      // so the page does not claim a selection it cannot save.
      if (selectedModel !== '') setSelectedModel('')
      return
    }
    if (!models.some(model => model.id === selectedModel)) {
      setSelectedModel(models[0]!.id)
    }
  }, [providers, namespaceView, selectedProvider, selectedModel])

  // Fold stored values into the draft while the user is not editing.
  useEffect(() => {
    if (dirty) return
    setTemperatureText(storedTemperature === undefined ? '' : String(storedTemperature))
    setEfforts(effortsDraftOf(modelProfile?.reasoningEfforts))
    setModalities(storedInput)
  }, [selectedProvider, selectedModel, storedTemperature, modelProfile?.reasoningEfforts, modelProfile?.input])

  const updateTemperature = (text: string): void => {
    setTemperatureText(text)
    setDirty(true)
    setOutcome(null)
  }
  const toggleOff = (checked: boolean): void => {
    setEfforts(current => ({ ...current, off: checked }))
    setDirty(true)
    setOutcome(null)
  }
  const toggleLevel = (level: OfferedLevel, checked: boolean): void => {
    setEfforts(current => ({
      ...current,
      levels: {
        ...current.levels,
        [level]: { ...current.levels[level], enabled: checked },
      },
    }))
    setDirty(true)
    setOutcome(null)
  }
  const updateWire = (level: OfferedLevel, text: string): void => {
    setEfforts(current => ({
      ...current,
      levels: {
        ...current.levels,
        [level]: { ...current.levels[level], text },
      },
    }))
    setDirty(true)
    setOutcome(null)
  }
  const toggleModality = (modality: Modality, checked: boolean): void => {
    setModalities(current => {
      const next = MODALITIES.filter(candidate =>
        candidate === modality ? checked : current?.includes(candidate) === true)
      // Unchecking the last box is the absence of a declaration, never `[]`.
      return next.length === 0 ? undefined : next
    })
    setDirty(true)
    setOutcome(null)
  }

  const save = async (): Promise<void> => {
    if (providerView === undefined || selectedModel === '') return
    const trimmed = temperatureText.trim()
    const temperature = trimmed === '' ? undefined : Number(trimmed)
    if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
      setOutcome({ status: 'error', message: 'Temperature must be a number between 0 and 2.' })
      return
    }
    setSaving(true)
    setOutcome(null)
    try {
      const result = await props.save({
        provider: selectedProvider,
        model: selectedModel,
        temperature,
        efforts: buildEfforts(efforts),
        input: modalities,
        settingsNs: providerView.settingsNs,
        settingsPath: providerView.settingsPath,
        modelIndex,
        revision: namespaceView?.revision,
      })
      setOutcome(result)
      if (result.status === 'saved') setDirty(false)
    } finally {
      setSaving(false)
    }
  }

  const ready = sampling.status === 'ready'
  const documentReady = document.status === 'ready'
  const effortsWriteable = modelIndex >= 0 && documentReady
  // Reasoning and modality edits cannot land without a user-owned model row,
  // and a save carries every half, so an unwritable declaration disables the
  // whole page rather than dropping part of a click silently.
  const reasoningDisabled = !ready || saving || !effortsWriteable
  const dirtyState = dirty
    || storedTemperature !== (temperatureText.trim() === '' ? undefined : Number(temperatureText))
    || !effortsMatch(efforts, modelProfile?.reasoningEfforts)
    || !modalitiesEqual(modalities, storedInput)
  const disabled = !ready || saving || !dirtyState || providerView === undefined || selectedModel === ''

  return <div style={styles.root}>
    <h2 style={styles.title}>Model Settings</h2>
    <p style={styles.copy}>
      Set a temperature per model, declare which input modalities it accepts, and declare which
      reasoning effort levels a custom gateway serves. Temperature is applied by this plugin on every
      request. Input modalities and reasoning efforts are written into the provider&apos;s own model
      entry, so the attachment path, the composer picker, and the wire read them with no plugin in the loop.
    </p>
    {providerError !== undefined && <p style={styles.error}>{providerError}</p>}
    {(providers === undefined || providers.length === 0) && providerError === undefined && (
      <p style={styles.copy}>Loading providers…</p>
    )}
    {(providers !== undefined && providers.length === 0) && (
      <p style={styles.copy}>
        No configurable providers found. Add one through Settings → Models first; this page edits
        models declared there.
      </p>
    )}
    {providerView !== undefined && (
      <div style={styles.grid}>
        <label htmlFor="pms-provider" style={styles.label}>Provider</label>
        <select
          id="pms-provider"
          style={styles.input}
          value={selectedProvider}
          disabled={saving}
          onChange={event => { setSelectedProvider(event.currentTarget.value); setDirty(false); setOutcome(null) }}
        >
          {providers?.map(row => (
            <option key={row.provider} value={row.provider}>{row.displayName} ({row.provider})</option>
          ))}
        </select>

        <label htmlFor="pms-model" style={styles.label}>Model</label>
        <select
          id="pms-model"
          style={styles.input}
          value={selectedModel}
          disabled={saving}
          onChange={event => { setSelectedModel(event.currentTarget.value); setDirty(false); setOutcome(null) }}
        >
          {models.map(model => (
            <option key={model.id} value={model.id}>{model.name ?? model.id}</option>
          ))}
        </select>

        <label htmlFor="pms-temperature" style={styles.label}>Temperature</label>
        <input
          id="pms-temperature"
          style={styles.input}
          type="number"
          min={0}
          max={2}
          step={0.1}
          value={temperatureText}
          placeholder="0 to 2, blank to send none"
          disabled={!ready || saving}
          onChange={event => updateTemperature(event.currentTarget.value)}
        />
      </div>
    )}
    {providerView !== undefined && selectedModel !== '' && (
      <div style={styles.modalityGrid}>
        {MODALITIES.map(modality => (
          <div key={modality} style={styles.effortCell}>
            <div style={styles.effortRow}>
              <input
                id={`pms-input-${modality}`}
                type="checkbox"
                checked={modalities?.includes(modality) === true}
                disabled={reasoningDisabled}
                onChange={event => toggleModality(modality, event.currentTarget.checked)}
              />
              <label htmlFor={`pms-input-${modality}`} style={styles.checkboxLabel}>
                {modality === 'text' ? 'Text input' : 'Image input'}
              </label>
            </div>
          </div>
        ))}
        <p style={{ ...styles.copy, gridColumn: '1 / -1', fontWeight: 500, color: 'var(--dsw-alias-label-secondary)' }}>
          Input modalities
        </p>
        <p style={{ ...styles.copy, gridColumn: '1 / -1' }}>
          What this model accepts in a request. Leaving every box clear stores no declaration, which
          keeps whatever the provider profile already resolves to — currently{' '}
          {effectiveInput === undefined ? 'unknown' : effectiveInput.join(', ')}. Declaring images is
          what makes a hand-declared vision model usable; declaring text alone corrects a model whose
          gateway refuses images. This is a claim about the endpoint, not a check of it: a model
          claiming images its gateway refuses is refused by the provider instead, mid-turn.
        </p>
      </div>
    )}
    {providerView !== undefined && selectedModel !== '' && (
      <div style={styles.effortGrid}>
        <div style={styles.effortCell}>
          <div style={styles.effortRow}>
            <input
              id="pms-off"
              type="checkbox"
              checked={efforts.off}
              disabled={reasoningDisabled}
              onChange={event => toggleOff(event.currentTarget.checked)}
            />
            <label htmlFor="pms-off" style={styles.checkboxLabel}>Off (no reasoning)</label>
          </div>
          <p style={styles.copy}>
            Checked alone, the model is declared non-reasoning. With levels below, the picker
            offers &quot;off&quot; and sends no reasoning parameter.
          </p>
        </div>
        {LEVELS.map(level => (
          <div key={level} style={styles.effortCell}>
            <div style={styles.effortRow}>
              <input
                id={`pms-level-${level}`}
                type="checkbox"
                checked={efforts.levels[level].enabled}
                disabled={reasoningDisabled}
                onChange={event => toggleLevel(level, event.currentTarget.checked)}
              />
              <label htmlFor={`pms-level-${level}`} style={styles.checkboxLabel}>{level}</label>
            </div>
            <input
              style={styles.input}
              value={efforts.levels[level].text}
              placeholder={level}
              disabled={reasoningDisabled || !efforts.levels[level].enabled}
              onChange={event => updateWire(level, event.currentTarget.value)}
            />
          </div>
        ))}
      </div>
    )}
    {providerView !== undefined && !effortsWriteable && (
      <p style={styles.copy}>
        Reasoning efforts need a model entry owned by this provider&apos;s settings; add the model on the
        Models page first. Temperature still works.
      </p>
    )}
    <div style={styles.actions}>
      <button
        type="button"
        style={{ ...styles.button, ...(disabled ? styles.disabled : {}) }}
        disabled={disabled}
        onClick={() => { void save() }}
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
      {outcome?.status === 'saved' && <p style={styles.status}>Saved.</p>}
      {outcome?.status === 'partial' && <p style={styles.error}>{outcome.message}</p>}
      {outcome?.status === 'error' && <p style={styles.error}>{outcome.message}</p>}
    </div>
  </div>
}
