import assert from 'node:assert/strict'
import { apply, applyTemperature, name } from '../lib/index.js'

const listeners = new Map()
let stored = { entries: [] }

function listener(event) {
  return listeners.get(event)?.[0]
}

const ctx = {
  settings: {
    register(namespace, schema) {
      assert.equal(namespace, 'per-model-sampling')
      assert.equal(typeof schema, 'function')
      return { get: () => stored }
    },
  },
  on(event, callback) {
    const values = listeners.get(event) ?? []
    values.push(callback)
    listeners.set(event, values)
    return () => {}
  },
}

assert.equal(name, 'per-model-sampling')
apply(ctx)

const request = listener('agent/request')
assert.equal(typeof request, 'function', 'apply registers the agent/request waterfall listener')

const propose = (config) => request({ agent: {}, turn: 1, step: 1, signal: new AbortController().signal },
  async () => config)

// No entries: a proposed temperature is dropped, so nothing rides in from a
// previous model or another producer.
assert.deepEqual(await propose({ provider: 'rtx-spark', model: 'a', temperature: 0.7 }),
  { provider: 'rtx-spark', model: 'a' })

// A matching entry sets its temperature.
stored = { entries: [{ provider: 'rtx-spark', model: 'a', temperature: 0.3 }] }
assert.deepEqual(await propose({ provider: 'rtx-spark', model: 'a' }),
  { provider: 'rtx-spark', model: 'a', temperature: 0.3 })

// A set temperature is overwritten by the configured one.
assert.deepEqual(await propose({ provider: 'rtx-spark', model: 'a', temperature: 0.9 }),
  { provider: 'rtx-spark', model: 'a', temperature: 0.3 })

// Model-switch stickiness: model b has no entry, so the temperature model a
// left on the proposal (the loop keeps whatever the last step logged) is gone.
assert.deepEqual(await propose({ provider: 'rtx-spark', model: 'b', temperature: 0.3 }),
  { provider: 'rtx-spark', model: 'b' })

// An entry with no temperature is an explicit "send none".
stored = { entries: [{ provider: 'rtx-spark', model: 'a' }] }
assert.deepEqual(await propose({ provider: 'rtx-spark', model: 'a', temperature: 0.3 }),
  { provider: 'rtx-spark', model: 'a' })

// Provider is part of the key: the same model id on another route does not match.
stored = { entries: [{ provider: 'rtx-spark', model: 'a', temperature: 0.3 }] }
assert.deepEqual(await propose({ provider: 'other-route', model: 'a' }),
  { provider: 'other-route', model: 'a' })

// The proposal is never mutated: the loop deep-freezes it before dispatch.
const frozen = Object.freeze({ provider: 'rtx-spark', model: 'a', temperature: 0.9 })
assert.deepEqual(await propose(frozen), { provider: 'rtx-spark', model: 'a', temperature: 0.3 })
assert.equal(frozen.temperature, 0.9, 'the seeded proposal is left untouched')

// Non-llm fields survive the rebuild.
assert.deepEqual(
  applyTemperature([{ provider: 'p', model: 'm', temperature: 0.2 }],
    { provider: 'p', model: 'm', maxTokens: 100, stop: ['x'] }),
  { provider: 'p', model: 'm', maxTokens: 100, stop: ['x'], temperature: 0.2 },
)

console.log('per-model-sampling smoke test passed')
