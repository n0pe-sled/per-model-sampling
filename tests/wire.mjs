/**
 * Wire proof: a temperature configured for one model reaches the adapter
 * dispatch for that model, and no model keeps another model's value.
 *
 * Uses the real settings provider (a temp file, never $DSH_HOME), the real
 * `dsh-llm` runtime, and a recording adapter standing in for the gateway.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { apply } from '../lib/index.js'

/** Captured requests, in dispatch order. */
const dispatched = []
const streamed = []

class RecordingAdapter extends LlmAdapter {
  stream(options) {
    dispatched.push(options)
    return (async function* () {})()
  }
}

const dir = await mkdtemp(join(tmpdir(), 'dsh-pms-wire-'))
const path = join(dir, 'settings.yaml')
const ctx = new Context()
try {
  await ctx.plugin(FileSettingsProvider, { path, watch: false })
  await ctx.plugin(LlmRuntime)
  apply(ctx)

  const signal = new AbortController().signal
  ctx.llm.registerAdapter(['rtx-spark'], new RecordingAdapter())
  ctx.on('llm/stream', (options, next) => {
    streamed.push(options)
    return next()
  })

  const namespace = settingsNamespace('per-model-sampling')
  await ctx.settings.update(namespace, {
    entries: [{ provider: 'rtx-spark', model: 'model-a', temperature: 0.3 }],
  })

  /** Run one loop-shaped request: seed → agent/request waterfall → prepare → dispatch. */
  const request = async (provider, model) => {
    const proposed = await ctx.waterfall(
      'agent/request',
      { agent: {}, turn: 1, step: 1, signal },
      () => Promise.resolve({ provider, model }),
    )
    const prepared = await ctx.llm.prepareCall(proposed, signal)
    const options = { ...prepared.config, messages: [createUserMessage('ping')] }
    for await (const _chunk of prepared.stream(options)) { /* drained */ }
    return proposed
  }

  // The configured model carries its temperature all the way to dispatch.
  const configured = await request('rtx-spark', 'model-a')
  assert.equal(configured.temperature, 0.3, 'the proposal carries the configured temperature')
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0].temperature, 0.3, 'the adapter receives the configured temperature')
  assert.equal(streamed[0].temperature, 0.3, 'the llm/stream listener sees the configured temperature')

  // An unconfigured model sends none.
  await request('rtx-spark', 'model-b')
  assert.equal(dispatched[1].temperature, undefined, 'an unconfigured model sends no temperature')

  // Model-switch stickiness: seed the proposal with the temperature the
  // previous step logged, as the loop does, and confirm it is dropped.
  const switched = await ctx.waterfall(
    'agent/request',
    { agent: {}, turn: 1, step: 1, signal },
    () => Promise.resolve({ provider: 'rtx-spark', model: 'model-b', temperature: 0.3 }),
  )
  assert.equal(switched.temperature, undefined, 'a switch to an unconfigured model drops the old temperature')

  // Clearing the entry clears the wire value.
  await ctx.settings.update(namespace, { entries: [] })
  await request('rtx-spark', 'model-a')
  assert.equal(dispatched.at(-1).temperature, undefined, 'clearing the entry clears the temperature')

  // The entry list round-trips through the settings document.
  await ctx.settings.update(namespace, {
    entries: [{ provider: 'rtx-spark', model: 'model-a', temperature: 0.9 }],
  })
  const document = await readFile(path, 'utf8')
  assert.match(document, /per-model-sampling/)
  assert.match(document, /0\.9/)
  assert.equal(ctx.settings.get(namespace).entries[0].temperature, 0.9)
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log('per-model-sampling wire test passed')
