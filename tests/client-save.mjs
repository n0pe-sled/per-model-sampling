/**
 * Client-half round trip against a real settings document.
 *
 * Drives the built browser bundle's save path with a stub client context whose
 * wire calls reach a real file-backed settings provider, then asserts what
 * landed: the reasoning-effort declaration under the provider's own
 * `providers.<route>.models[]`, the temperature under this plugin's namespace,
 * and nothing else disturbed — in particular no schema defaults materialized
 * into the user layer.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'

const require = createRequire(import.meta.url)

// The client bundle is the harness's module-loader factory format. Load it the
// way the browser does, resolving its externals from this package's install.
let bundle
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      bundle = { id, exports: factory(require) }
    },
  },
}
await import('../lib/client.js')
assert.equal(bundle?.id, 'dsh-per-model-sampling')
assert.equal(typeof bundle.exports.apply, 'function')

/** A pi-ai-shaped provider section, including the fields this page must not touch. */
const piAiLike = z.object({
  providers: z.dict(z.object({
    api: z.union(['openai-completions']),
    baseURL: z.string(),
    models: z.array(z.object({
      id: z.string().required(),
      name: z.string(),
      contextWindow: z.number(),
      maxTokens: z.number(),
      input: z.array(z.union(['text', 'image'])),
      reasoningEfforts: z.union([
        z.const(false),
        z.dict(z.union([z.string(), z.const(null)]), z.union([
          'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
        ])),
      ]),
    })),
  })),
})

const dir = await mkdtemp(join(tmpdir(), 'dsh-pms-client-'))
const path = join(dir, 'settings.yaml')
const ctx = new Context()
try {
  await ctx.plugin(FileSettingsProvider, { path, watch: false })

  const providerNs = settingsNamespace('llm-pi-ai')
  const pluginNs = settingsNamespace('per-model-sampling')
  ctx.settings.register(providerNs, piAiLike)
  // The node half owns the plugin namespace schema; the test registers the
  // same shape the client writes into.
  const pluginScope = ctx.settings.register(pluginNs, z.object({
    entries: z.array(z.object({
      provider: z.string().required(),
      model: z.string().required(),
      temperature: z.number().min(0).max(2),
    })).default([]),
  }))

  const route = 'rtx-spark'
  await ctx.settings.update(providerNs, {
    providers: {
      [route]: {
        api: 'openai-completions',
        baseURL: 'http://10.0.100.226:8000/v1',
        models: [
          { id: 'model-a', name: 'Model A', contextWindow: 1008128 },
          { id: 'model-b' },
        ],
      },
    },
  })

  /** The describe face the client's apply reads: a mirror over real descriptors. */
  const viewOf = (ns) => {
    const descriptor = ctx.settings.describe().find(entry => entry.ns === ns)
    if (descriptor === undefined) return undefined
    return {
      ns: descriptor.ns,
      schema: descriptor.schema,
      value: descriptor.value,
      ...descriptor.user === undefined ? {} : { user: descriptor.user },
      applies: descriptor.applies,
      secrets: [],
      revision: descriptor.revision,
    }
  }
  let namespaces = [viewOf(providerNs), viewOf(pluginNs)]
  const describe = {
    getSnapshot: () => ({ status: 'ready', view: { namespaces, writable: true, hasDocument: true }, error: null }),
    subscribe: () => () => {},
    ensure: async () => {},
    acceptView(view) {
      namespaces = namespaces.some(row => row.ns === view.ns)
        ? namespaces.map(row => row.ns === view.ns ? view : row)
        : [...namespaces, view]
    },
  }
  const scope = {
    getSnapshot: () => {
      const view = namespaces.find(row => row.ns === pluginNs)
      return {
        status: 'ready',
        value: view?.value ?? { entries: [] },
        base: undefined,
        user: view?.user,
        revision: view?.revision,
        writable: true,
        mode: 'host',
      }
    },
    subscribe: () => () => {},
    // The real controller folds its write answer into the shared mirror before
    // settlement; this stub does the same so the page's read-back is real.
    set: async (field, value) => {
      await ctx.settings.update(pluginNs, { [field]: value })
      describe.acceptView(viewOf(pluginNs))
    },
    unset: async (field) => {
      await ctx.settings.update(pluginNs, { [field]: undefined })
      describe.acceptView(viewOf(pluginNs))
    },
  }

  let registration
  const clientCtx = {
    settingsScope: {
      bind: () => scope,
      describe: () => describe,
    },
    slots: {
      inject: (_name, factory) => factory(),
      register: (options) => { registration = options; return options },
    },
    get: (name) => name === 'connection'
      ? {
        api: {
          llm: {
            providers: async () => ({
              result: {
                ok: true,
                value: {
                  providers: [{
                    provider: route,
                    displayName: 'RTX Spark',
                    settingsNs: providerNs,
                    settingsPath: ['providers', route],
                    active: true,
                  }],
                },
              },
            }),
          },
          settings: {
            mutate: async (payload) => {
              try {
                await ctx.settings.mutate(
                  settingsNamespace(payload.ns),
                  payload.ops,
                  payload.expectedRevision,
                )
                return { result: { ok: true, value: viewOf(settingsNamespace(payload.ns)) } }
              } catch (error) {
                return { result: { ok: false, error: { message: error.message } } }
              }
            },
          },
        },
      }
      : undefined,
  }

  bundle.exports.apply(clientCtx)
  assert.equal(registration.id, 'per-model-sampling')
  assert.equal(registration.name, 'settings.section')
  const face = registration.inject()
  assert.equal(typeof face.save, 'function')
  assert.equal(typeof face.ensureDocument, 'function')

  const revision = () => viewOf(providerNs).revision
  const storedModels = () => ctx.settings.describe()
    .find(entry => entry.ns === providerNs).user.providers[route].models
  const resolvedModels = () => viewOf(providerNs).value.providers[route].models
  const storedEntries = () => pluginScope.get().entries

  // The resolved value materializes `input: []` on an entry that declares
  // nothing, which is why the save rebuilds from the raw user layer: writing
  // the resolved list back would turn "no answer" into the claim that the
  // model accepts nothing.
  assert.deepEqual(resolvedModels()[0].input, [], 'the schema materializes an empty list')
  assert.equal('input' in storedModels()[0], false, 'the user layer carries no such default')

  // Write a reasoning declaration, an input-modality declaration, and a
  // temperature for one of two models.
  const saved = await face.save({
    provider: route,
    model: 'model-a',
    temperature: 0.4,
    efforts: { low: 'low', high: 'high' },
    input: ['text', 'image'],
    settingsNs: providerNs,
    settingsPath: ['providers', route],
    modelIndex: 0,
    revision: revision(),
  })
  assert.deepEqual(saved, { status: 'saved' })

  // Both declarations landed on the model entry, in the provider's namespace.
  const models = storedModels()
  assert.deepEqual(models[0].reasoningEfforts, { low: 'low', high: 'high' })
  assert.deepEqual(models[0].input, ['text', 'image'])
  assert.equal(models[0].id, 'model-a')
  assert.equal(models[0].contextWindow, 1008128, 'the fields this page does not edit survive')
  // The untouched row is untouched, and no schema default was materialized:
  // `input` is absent from the user layer of the row nobody edited, not stored
  // as the resolved `[]`.
  assert.deepEqual(models[1], { id: 'model-b' })

  // The temperature landed in this plugin's namespace, and nowhere else.
  assert.deepEqual(storedEntries(), [{ provider: route, model: 'model-a', temperature: 0.4 }])
  assert.equal('reasoningEfforts' in storedEntries()[0], false)

  // The write reached the document on disk.
  const document = await readFile(path, 'utf8')
  assert.match(document, /reasoningEfforts/)
  assert.match(document, /0\.4/)
  assert.match(document, /image/)

  // Clearing the declaration removes the keys rather than storing undefined or
  // an empty list, which resolution would read as a declaration anyway.
  const cleared = await face.save({
    provider: route,
    model: 'model-a',
    temperature: 0.4,
    efforts: undefined,
    input: undefined,
    settingsNs: providerNs,
    settingsPath: ['providers', route],
    modelIndex: 0,
    revision: revision(),
  })
  assert.deepEqual(cleared, { status: 'saved' })
  assert.equal('reasoningEfforts' in storedModels()[0], false)
  assert.equal('input' in storedModels()[0], false)

  // Declaring text alone is a real declaration — the correction for a catalog
  // model whose gateway refuses images — and it is distinguishable from the
  // absence of one.
  await face.save({
    provider: route,
    model: 'model-a',
    temperature: 0.4,
    efforts: undefined,
    input: ['text'],
    settingsNs: providerNs,
    settingsPath: ['providers', route],
    modelIndex: 0,
    revision: revision(),
  })
  assert.deepEqual(storedModels()[0].input, ['text'])

  // Declaring a non-reasoning model stores the literal false, and an input
  // declaration written in the same save survives it.
  await face.save({
    provider: route,
    model: 'model-a',
    temperature: undefined,
    efforts: false,
    input: ['text', 'image'],
    settingsNs: providerNs,
    settingsPath: ['providers', route],
    modelIndex: 0,
    revision: revision(),
  })
  assert.equal(storedModels()[0].reasoningEfforts, false)
  assert.deepEqual(storedModels()[0].input, ['text', 'image'])
  // Clearing the temperature drops its entry.
  assert.deepEqual(storedEntries(), [])

  // A stale revision is refused, and the temperature half still reports what
  // happened rather than claiming a clean save.
  const stale = await face.save({
    provider: route,
    model: 'model-a',
    temperature: 0.4,
    efforts: { low: 'low' },
    input: ['text'],
    settingsNs: providerNs,
    settingsPath: ['providers', route],
    modelIndex: 0,
    revision: revision() - 1,
  })
  assert.equal(stale.status, 'partial', JSON.stringify(stale))
  assert.match(stale.message, /Temperature saved/)
  assert.equal(storedModels()[0].reasoningEfforts, false, 'a refused write changes nothing')
  assert.deepEqual(storedModels()[0].input, ['text', 'image'], 'a refused write changes nothing')
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log('per-model-sampling client save test passed')
