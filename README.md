# dsh-per-model-sampling

Per-model sampling and capability controls for hand-declared providers, under
**Settings → Model Settings** (the page sits between Models and Logins in the nav).

The trigger case is a vLLM-style gateway declared through the custom-provider card, where the
model rows offer no place to set a temperature, no place to declare which reasoning effort levels
the gateway serves, and no place to say whether the model takes images. This plugin adds all three,
and nothing else.

| Control | Where it lands | Who applies it |
|---|---|---|
| temperature | this plugin's `per-model-sampling` settings namespace | the node half, inside the `agent/request` waterfall |
| input modalities | the provider's own namespace (`llm-pi-ai`'s `providers.<route>.models[].input`) | nobody: resolution, the attachment path, and the adapter read the profile directly |
| reasoning efforts | the provider's own namespace (`llm-pi-ai`'s `providers.<route>.models[]`) | nobody: the composer picker, the resolver, and the adapter read the profile directly |

## Install

```bash
dsh plugin --profile web add ~/dsh-plugins/per-model-sampling
# restart the GUI
```

The bundle's single `cordis.patch.yml` row mounts the node half and puts the package on the
browser roster, so the settings page appears without extra wiring.

## Temperature

The node half registers one `agent/request` waterfall listener. The agent loop seeds a request
proposal from the logged session header, dispatches `agent/request`, and only then calls
`llm.prepareCall()` (`packages/core/agent-loop/src/agent.ts`), so the temperature this listener
returns is what the adapters map onto the wire. `llm-pi-ai` passes `options.temperature` straight
through to the provider request.

The lookup keys on the proposal's own provider and model on every request, because the proposal
carries whatever the previous step left there (`requestProposal` strips only adapter-supplied
`reasoningEffort`/`maxTokens`). The rules:

- a matching entry with a temperature sets it, even if the proposal already had a different one
- a matching entry without a temperature sends none
- no matching entry sends none, so a temperature configured for one model never rides into a
  mid-session switch to another

The proposal the loop hands plugins is deep-frozen, so removal returns a rebuilt config instead of
deleting a field.

## Input modalities

`PiAiModelProfile.input` (`llm-pi-ai`'s `catalog.ts`) is the one modality field in the stack, and it
is load-bearing: `llm-pi-ai`'s adapter throws `UNSUPPORTED_CONTENT` when a request carries an image
and the model's resolved `input` omits `image`, and the API proxy refuses the attachment earlier
still. What was missing was a way to write it, because nothing interrogates a gateway for what it
accepts — a model id saying `vision` is a name, not a capability.

The page offers two boxes, **Text input** and **Image input**, writing `providers.<route>.models[i].input`.
Three rules the control follows, each of which the code states rather than the UI:

- **Clearing every box stores no declaration, never `[]`.** Resolution reads an empty list as "no
  answer here" (`declaredInput`), so the key is removed and the model keeps the installed catalog's
  list, then the route's `defaultInput` (itself `[text]` by default). A stored `[]` would be a claim
  that the model accepts nothing.
- **The checkboxes reflect the user layer, not the resolved value.** An absent `input` resolves to
  the route default, so a model inheriting `[text]` is indistinguishable from one declaring it once
  resolution has run. The panel reads the raw user entry for the boxes and the resolved entry only
  for the "currently …" note.
- **Text alone is a real declaration.** It is the correction for a catalog model whose gateway
  refuses images, and it is distinguishable from no declaration at all.

This is a claim about the endpoint, not a check of it. Over-claiming admits an image the provider
rejects mid-turn, after the message is durable; under-claiming refuses it before it is attached.

### There is no output modality

pi-ai's `Model` type carries `input: ("text" | "image")[]` and no output field, and the harness's
`LlmModelInfo` reports only `inputModalities`. Nothing in the request path, the attachment path, or
either adapter reads an output modality, so a control for one would write a key nothing consumes.
Adding it is core work in `llm-pi-ai` plus whatever would read it, not a settings-panel change.

## Reasoning efforts

`reasoningEfforts` already works end to end below the UI: `PiAiModelProfile.reasoningEfforts` is
adapter config, and the composer reads the levels the profile declares. What was missing was a way
to write it, so this page edits the provider's own model entry. The picker then offers the levels
with no plugin in the request path.

Two consequences worth knowing:

- The page shows modality and reasoning controls only for a model owned by the provider's **user**
  settings layer. Add the model on the Models page first; a model that exists only in an inherited
  layer has no array to edit. Temperature is the one control that works without a user-owned row.
- Editing a row on the Models page afterwards keeps the declarations. That editor patches rows with
  `Object.entries({ ...model, ...next })`, so keys it does not render survive.

### Why the write replaces the whole models array

The settings path mutator cannot address an array element: a path like
`providers.<route>.models.0.reasoningEfforts` walks to `models` and, finding an array where it
expected an object, replaces the array with an object and the schema rejects the result
(`expected array but got [object Object]`). So the page rebuilds the whole `models` array and writes
it at `providers.<route>.models`.

It rebuilds from the raw user layer, never from the resolved value. The resolved value carries
materialized defaults, including `input: []` on every entry, and persisting those would change what
the model accepts — an `input: []` is the schema's way of saying "this entry states no answer", and
stored as a value it would be the claim that the model accepts nothing.

## Settings shape

The page writes to two places. The plugin owns only the temperature:

```yaml
per-model-sampling:
  entries:
    - provider: rtx-spark
      model: deepseek-v4-flash-vision-exp
      temperature: 0.4
```

`temperature` is optional and bounded to 0 through 2. An entry without one behaves like no entry at
all, which is how the page clears a value.

The capability declarations land in the provider's own namespace, on the model entry:

```yaml
llm-pi-ai:
  providers:
    rtx-spark:
      models:
        - id: deepseek-v4-flash-vision-exp
          input: [text, image]
          reasoningEfforts:
            low: low
            high: high
```

## What this plugin does not do

- **Output modalities.** pi-ai's `Model` type has no output field and nothing in the harness reads
  one, so there is nothing to write to. See above.
- **`top_p` and `top_k`.** Neither exists anywhere in the request path today. Nothing in
  `GenerateOptions`, `LlmCallConfig`, `WireRequest`, or either adapter names them, requests are
  deep-frozen before dispatch, and `llm/stream` listeners read rather than rewrite. There is no seam
  where a plugin injects a new wire field into an adapter it does not own, so these need a harness
  change first.
- **`chatTemplateKwargs` as a workaround.** pi-ai reads `chat_template_kwargs` only under the two
  `chat-template` thinking formats. A plain `openai-completions` route sends them nowhere, so this
  page does not offer the field.
- **Per-model request defaults.** `temperature` is applied by a listener, not by the adapter, so the
  adapter's own resolve step knows nothing about it. The adapter-owned equivalent
  (`LlmResolvedModelInfo.defaultTemperature`) is core work.
- **Model discovery.** The reasoning-effort and temperature facts a gateway advertises are not in
  any listing endpoint this plugin can read, and modalities are not either: nothing interrogates a
  gateway for what it accepts. Discovery metadata has its own gap (vLLM answers `max_model_len`,
  which `llm-pi-ai` currently drops).

## Verification

```bash
pnpm build      # tsdown: node half + browser bundle
pnpm typecheck
pnpm test
```

`tests/smoke.mjs` drives the node half's listener with a stubbed context and asserts the set, drop,
and model-switch cases. `tests/wire.mjs` boots the real settings provider (a temp file) and the real
`dsh-llm` runtime with a recording adapter, then asserts the temperature reaches the adapter and the
`llm/stream` waterfall for the configured model and is absent for the others. `tests/client-save.mjs`
loads the built browser bundle through a stub module loader, drives its real save path against a real
settings document, and asserts both declarations land under `providers.<route>.models[]` — the
modality list and the reasoning-effort dict — that the untouched rows survive, that clearing either
removes the key rather than storing `[]` or `undefined`, that no materialized defaults are persisted,
that the temperature lands only in this plugin's namespace, and that a stale revision is refused
without changing anything.

Two things this cannot check from here: the rendered page (no browser installed for the Playwright
harness) and a real gateway's request log. A live check is worth doing once per gateway:

```bash
curl -s http://10.0.100.226:8000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-v4-flash-vision-exp","messages":[{"role":"user","content":"hi"}],"temperature":0.4,"max_tokens":16}'
```

## Notes for maintainers

- `package.json` pins exact versions. dsh packages publish at `0.1.1-rc.2` under `next`; `latest` is
  stale for runtime packages.
- The host's published contract packages import relatively with `.ts` extensions in their `.d.ts`,
  so `IApiClient` and its wire views resolve to `any` outside the harness repo's source-level
  `paths` facade. This package carries no facade, so `src/client/SamplingPanel.tsx` declares the two
  wire shapes it consumes. Matching those declarations against the host contract is part of
  upgrading a dsh version.
- The modality vocabulary is declared twice on purpose: `MODALITIES` in `SamplingPanel.tsx` mirrors
  `llm-pi-ai`'s `catalog.ts` gate, which mirrors pi-ai's `Model['input']`. A pi-ai upgrade that adds
  a modality fails compilation in the harness first (that `Record` is a drift gate), so this list is
  where the panel catches up. A modality added there and not here is silently not offered.
- The panel writes `input` and `reasoningEfforts` in one `settings.mutate`, so a save reports
  `partial` with the temperature already landed when the profile half is refused. That is why the
  read-back checks both keys instead of trusting the mutate answer.
- `node_modules` in this checkout was installed from a macOS pnpm store. Building on Linux needs the
  platform bindings `tsdown` pulls in (`@rolldown/binding-linux-arm64-gnu`,
  `@yuku-codegen/binding-linux-arm64-gnu`, `@yuku-parser/binding-linux-arm64-gnu` at the versions the
  lockfile pins), copied in and linked under the matching `.pnpm` entries; `pnpm add` refuses because
  the store path differs.
