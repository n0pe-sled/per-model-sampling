/**
 * Provider selection on the client half.
 *
 * The panel must offer only the providers this deployment has configured. The
 * host answers `llm.providers` with the whole configurable-provider directory —
 * every route its adapters ship, configured or not — so the filter is the one
 * thing standing between the user and a dropdown of providers they cannot reach.
 * It is checked here rather than through a rendered panel because the built
 * browser bundle is what the browser loads and what this suite can load too.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

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

const { configuredProviders } = bundle.exports
assert.equal(typeof configuredProviders, 'function', 'the bundle carries the selection filter')

/** One row as the host's ConfigurableProviderView reports it. */
const row = (provider, active, extra = {}) => ({
  provider,
  displayName: provider,
  settingsNs: 'llm-pi-ai',
  settingsPath: ['providers', provider],
  active,
  ...extra,
})

// The directory the host sends for a deployment with one configured route, which
// is the shape of the bug: every other row is a provider the adapter ships and
// this deployment never configured.
const directory = [
  row('rtx-spark', true),
  row('deepseek-official', false),
  row('anthropic', false, { declared: false }),
  row('openai', false),
  row('google', false),
]

assert.deepEqual(
  configuredProviders(directory).map(entry => entry.provider),
  ['rtx-spark'],
  'only the configured route is offered',
)

// A row without a settings address cannot be written to: the capability controls
// save into the provider's own profile, and the host leaves the address empty for
// a route registered without a directory declaration.
assert.deepEqual(
  configuredProviders([row('bare-route', true, { settingsNs: '', settingsPath: [] })]),
  [],
  'an active route with no settings address is not offered',
)

// A declared custom route is offered exactly like a shipped one: `declared` says
// the owning adapter draws the distinction, not whether the user configured it.
assert.deepEqual(
  configuredProviders([row('gateway', true, { declared: true })]).map(entry => entry.provider),
  ['gateway'],
  'a hand-declared configured route is offered',
)

// An empty answer, and a dormant route, both leave the page with nothing to offer
// rather than a list of providers it cannot reach.
assert.deepEqual(configuredProviders([]), [], 'an empty directory offers nothing')
assert.deepEqual(
  configuredProviders([row('openai', false, { declared: true }), row('anthropic', false)]),
  [],
  'dormant routes are never offered',
)

// Order and identity survive the filter: the panel defaults to the first row it is
// handed, and the model half of the page reads `settingsPath` off it.
const configured = configuredProviders([row('a', false), row('b', true), row('c', true)])
assert.deepEqual(configured.map(entry => entry.provider), ['b', 'c'], 'directory order is kept')
assert.deepEqual(configured[0], row('b', true), 'the rows themselves pass through untouched')

console.log('per-model-sampling client providers test passed')
