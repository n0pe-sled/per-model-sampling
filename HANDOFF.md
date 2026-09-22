# Handoff: per-model sampling controls and richer model discovery for custom providers

> **Status.** Part 1 shipped: temperature (node half), reasoning efforts, and input modalities
> (client half) are live under Settings → Model Settings. `README.md` is the current description of
> what the plugin does and why; this document is the planning record behind it. Part 2, richer model
> discovery, is still open, and the table below is still the right map for it.
>
> One correction to the table: **input modalities** were not in the original ask but were added
> afterwards. They are plugin-only, like reasoning efforts — `PiAiModelProfile.input` exists and is
> enforced, the UI was the gap. Output modalities are not implementable as a settings change: pi-ai's
> `Model` type has no output field.

Target plugin: `dsh-per-model-sampling`, install path `per-model-sampling/`.
Reference checkout: `/opt/deepseek/deepseek-harness` (symlinked as `deepseek-harness/` from the plugins repo root).
Read `/opt/deepseek/deepseek-harness-plugins/README.md` and one existing bundle (`configurable-subagents/` is the closest shape) before scaffolding.

## What the user asked for

Per-model controls, under Settings → provider → model rows, for custom (hand-declared) providers:

1. reasoning effort
2. temperature
3. top_p

The trigger case is a vLLM-style gateway declared through the custom-provider card. The user's own route is `rtx-spark`, base URL `http://10.0.100.226:8000/v1`, protocol `openai-completions`, one model `deepseek-v4-flash-vision-exp`.

## Read this before you plan

The three fields are not three equal tasks. They land in three different places, and one of them cannot be done as a plugin at all. Verify this yourself before committing to an architecture; every claim below was checked against the checkout and carries a line reference.

| Field | End-to-end today? | Where the work goes |
|---|---|---|
| reasoning effort | Yes, config exists, UI missing | Plugin only (client half) |
| temperature | Yes, request field exists, no producer | Plugin only (node half + client half) |
| input modalities | Yes, `PiAiModelProfile.input` exists and the adapter enforces it | Plugin only (client half) |
| output modalities | No. pi-ai's `Model` type has no output field and nothing reads one | Harness core PR, and a consumer that would use it |
| top_p | No. Absent from the whole pipeline | Harness core PR, then plugin UI |
| richer "fetch available models" | Partial, and it drops what vLLM sends | Harness core PR. See Part 2 |

Part 1 is the sampling controls above. Part 2, further down, covers model discovery. Read both before planning; the discovery work has a one-line fix in it that is worth more to this user than the whole sampling UI.

### Reasoning effort already works below the UI

`PiAiModelProfile.reasoningEfforts` exists at `packages/llm/llm-pi-ai/src/catalog.ts:567`. Its type is `PiAiReasoningEfforts` (`catalog.ts:198`): each key is a level the selectors offer, each value is the wire spelling dispatch sends. `false` declares a non-reasoning model. A non-empty dict declares the offer.

The composer already renders it. `packages/client/ui-model-selection/src/client/ModelSelect.tsx:96` maps `reasoning.efforts` into menu entries and `:338` renders them. Nothing in the picker needs to change.

What is missing is only the authoring surface. The Settings model-row editor handles `id`, `name`, `contextWindow`, `maxTokens` and nothing else (`packages/client/ui-settings-models/src/client/DeepSeekModelsEditor.tsx:20`, `ModelListEditor.tsx:117`). So today a user must hand-edit `settings.yaml`.

Good news for you: the row editor preserves fields it does not render. `ModelListEditor.tsx:213-228` patches a row with `Object.entries({ ...model, ...next })`, so a `reasoningEfforts` key you write into a row survives the user editing that row's name or capacities. Do not "fix" that spread into a narrowed rebuild.

### Temperature is plumbed but has no producer

`temperature` exists at every layer that matters:

- `GenerateOptions.temperature` — `packages/llm/llm/src/types.ts:357`
- `LlmCallConfig.temperature` — `packages/llm/llm/src/call-config.ts:27`, compared by `callConfigEquals` at `:54`
- DeepSeek twin wire mapping — `packages/llm/llm-deepseek/src/serialize.ts:363`
- pi-ai twin wire mapping — `packages/llm/llm-pi-ai/src/adapter.ts:369`

Nothing sets it. `resolveCallWithInfo` (`packages/llm/llm/src/index.ts:780-812`) applies defaults to `maxTokens` and `reasoningEffort` only. `LlmCallConfigAdapterDefaults` (`call-config.ts:36-39`) has exactly two keys. `LlmResolvedModelInfo` (`packages/llm/llm/src/types.ts:274-281`) carries `context`, `defaultMaxTokens`, `reasoning`, and no temperature. The DeepSeek adapter's `RequestDefaults` (`serialize.ts:22-25`) is thinking-only.

The archived note `.agents/notes/archived/simplification/2026-07-04-drop-inert-request-knobs.md` says the shipped hook bridges set no request fields at all, and that a request-mutating plugin on `agent/request` is the intended consumer of `temperature` and `stop`. That is your extension point.

### top_p does not exist anywhere

`rg` for `top_p`, `topP`, `top_k`, `topK` across the checkout returns nothing in the request path. Not in `GenerateOptions`, not in `LlmCallConfig`, not in `WireRequest` (`packages/llm/llm-deepseek/src/types.ts:13-29`), not in either adapter. `packages/llm/llm/README.md:103` states the vocabulary outright: sampling is `temperature`/`maxTokens`/`stop` only, and grows when a producer lands.

A plugin cannot add it. Requests are deep-frozen before dispatch (`deepFreeze` in `call-config.ts:88`) and the README is explicit that `llm/stream` listeners read, never rewrite. There is no seam where a plugin injects a new wire field into an adapter it does not own.

Do not sell the user a plugin-only top_p. It does not exist and cannot be built without touching core.

### Do not use `chatTemplateKwargs` as a shortcut

Tempting, because vLLM reads sampling params from `chat_template_kwargs` and the field is configurable (`catalog.ts:366`, schema at `config.ts:256`). It is a trap for this gateway. The harness comment at `catalog.ts:360-366` says pi-ai reads `chat_template_kwargs` only under the two `chat-template` thinking formats, and nothing checks the pairing: "kwargs set beside another format are sent nowhere." The user's route is plain `openai-completions`, so kwargs written there would silently do nothing. If you surface this field at all, gate it on `compat.thinkingFormat` being a `chat-template` variant and say so in the UI.

## Recommended architecture

Ship it in two phases. Phase 1 is a real plugin that works against the current core. Phase 2 is a core PR that makes the plugin's temperature path redundant and unblocks top_p. Do phase 1 first so the user has something usable this week.

### Phase 1, plugin only

**Node half.** Register a settings namespace `per-model-sampling` holding a list of `{ provider, model, temperature? }` entries. Install one `agent/request` waterfall listener that looks up the proposed `provider` + `model` and sets or deletes `temperature` on the proposed config, then calls `next()`.

The loop seeds the proposal at `packages/core/agent-loop/src/agent.ts:447`, dispatches `agent/request` at `:457`, and calls `llm.prepareCall()` at `:468`. Your listener runs before prepare.

Handle stickiness deliberately. The header holds whatever you set, and `requestProposal` (`agent.ts:55-61`) only strips adapter-supplied `reasoningEffort`/`maxTokens`. So a temperature you set carries into later steps and across a mid-session model switch unless you re-decide on every proposal. Key the lookup on the proposal's own provider and model each time, and delete the field when no entry matches. Otherwise the user switches to a model with no configured temperature and keeps the previous model's value.

**Client half.** Add a Settings section via `ctx.slots.inject('settings.section', ...)` — the same slot the models page uses at `packages/client/ui-settings-models/src/client/index.ts:121`. Do not try to edit the shipped model rows in place. You cannot reach inside `ModelListEditor` from outside the package.

Two write targets, and the split is not cosmetic:

- Write `reasoningEfforts` into `llm-pi-ai`'s own `providers.<route>.models[]`. That is the adapter's field, so the composer picker, the resolver, and the wire all read it with no plugin in the loop. Your UI is an editor for existing config.
- Write `temperature` into the plugin's own namespace, because `PiAiModelProfile` has no temperature field and you cannot add one from outside.

Bind `ctx.settingsScope` once in `apply`, with an explicit generic. Calling `bind()` inside the inject factory registers a `ctx.effect` per render occurrence and leaks a controller.

### Phase 2, harness core PR

This is the clean end state. It also unblocks top_p.

Add per-model request defaults to the adapter-owned model info, mirroring how `defaultMaxTokens` already works:

1. `LlmResolvedModelInfo` gains `defaultTemperature?: number` and `defaultTopP?: number` — `packages/llm/llm/src/types.ts:274`.
2. `PiAiModelProfile` gains `temperature?: number` and `topP?: number` — `packages/llm/llm-pi-ai/src/catalog.ts:534`.
3. `resolveCallWithInfo` defaults them the way it defaults `maxTokens` — `packages/llm/llm/src/index.ts:784`.
4. `LlmCallConfigAdapterDefaults` gains the matching marker keys — `call-config.ts:36` — and `requestProposal` strips them — `agent.ts:55`.
5. `GenerateOptions` and `LlmCallConfig` gain `topP` — `types.ts:357`, `call-config.ts:27` — and `callConfigEquals` compares it — `call-config.ts:49`.
6. Both twin adapters map it to the wire. DeepSeek `serialize.ts:363` region, pi-ai `adapter.ts:369` region. The twin-adapter note `.agents/notes/implemented/architecture/2026-06-13-twin-llm-adapters.md` is why both must move together.
7. The agent-loop header invariant must compare it. `packages/core/agent-loop/src/invariant.ts:44-49` currently checks model, system, temperature, maxTokens, stop, tools. Skip this and log reconstruction silently drifts on your new field.
8. Both SDK projections. The repo rule is that `agent-loop` and `SessionEventMap` changes update the TypeScript and Python SDK expected outputs in the same PR, and `pnpm run test` covers neither.

Also update `packages/llm/llm/README.md:103`, which currently states the sampling vocabulary is temperature/maxTokens/stop. That line is a gate on the claim you are changing.

## Repo rules that will bite you

From `/opt/deepseek/deepseek-harness/AGENTS.md` and `packages/AGENTS.md`:

- **Model-visible means logged.** Anything reaching a model request must be reconstructable from the session log. This is why step 7 above is not optional.
- **No hardcoded tunables in plugins.** Deployment-varying values are validated `Config` fields, not `DEFAULT_*` constants.
- **Non-trivial changes need an Agent Note in the same PR.** Phase 2 certainly qualifies. Read `.agents/notes/README.md` for the bar.
- **Bilingual docs.** Docs and READMEs are zh/en pairs. Do not run `dsh-translate-docs` without explicit user invocation; write both or ask.
- **Misconfiguration fails loud.** An effort level the model does not declare should refuse at resolve time with `UNSUPPORTED_REASONING_EFFORT`, which the core already does. Do not add clamping to paper over a bad setting. The 2026-07-24 note rejected clamping on purpose: a silent substitution makes the control differ from the logged request.

## Plugin scaffolding notes

From the authoring skill, all verified the hard way in a prior session:

- `import Schema from '@deepseek-ai/schemastery'`. Default export only. `import { Schema }` fails at runtime.
- `ctx.settings` and other augmented members need type-only imports of the owning packages or `Context` stays bare.
- `ctx.settings.register(ns, schema)` wants the branded `SettingsNamespace`. Use `settingsNamespace('per-model-sampling')` as a value import, not a bare string.
- One `insert` row in `cordis.patch.yml` serves both the node half and the browser roster. The registry serves the package's `./client` export, so a client-half edit needs a rebuild plus a harness restart.
- `ctx.slots.inject(name, () => ctx.slots.register({...}, Component))`. The inject form tolerates the slot declaration arriving later; a bare `register` at apply time may run before the slot exists.
- Copy `packages/tsdown/tsdown.client.ts` for the browser half. Do not reinvent the externals list, banner, footer, or intro.
- No CSS pipeline. Inline styles against `--dsw-alias-*` tokens.
- Pin exact versions. `dsh` packages publish at `0.1.1-rc.2` under `next`; `latest` is stale. cordis `4.0.1`, schemastery `3.18.1`, React `18.3.1`.

## Verification

1. **Node smoke, no harness.** Import the built node half, stub the context, assert `typeof Config === 'function'` and that `apply(ctx, Config({}))` registers the namespace and the waterfall listener. `node tests/smoke.mjs`.
2. **Real settings round-trip.** Temp dir, real `dsh-settings-file` backed by a temp file, never `$DSH_HOME`. Write a `reasoningEfforts` entry through the plugin UI path, read it back, confirm it landed under `providers.<route>.models[]` and not in the plugin namespace.
3. **Wire proof for temperature.** This is the only test that matters for phase 1. Register a listener on `llm/stream` and assert the outgoing `GenerateOptions.temperature` is the configured value for the matching model and absent for the others. A settings value that never reaches the wire is the failure mode here.
4. **Model-switch stickiness.** Configure temperature for model A only. Switch the session to model B. Assert B's requests carry no temperature. This catches the `requestProposal` carry-over described above.
5. **Browser without disturbing the running GUI.** Boot a second instance on another port, `dsh web --no-open --port <other>`. Confirm the bundle serves 200 and the boot graph lists the plugin. There is a live GUI on this machine at `127.0.0.1:53368`; leave it alone.
6. **Read back after every write.** The browser `set()` never rejects on host refusal, it recovers by reloading the mirror. Only a read-back tells you the write landed.

# Part 2: richer "fetch available models"

The ask: when the user clicks Fetch available models, pull everything the endpoint will actually give up about each model, including from the health endpoint.

I probed the user's live gateway on 2026-07-30 to find out what is really there. Everything in this part is measured, not assumed.

## What the action does today

`packages/llm/llm-pi-ai/src/discovery.ts` owns it.

- A route the installed pi-ai catalog ships is answered from that catalog with no network call at all (`discovery.ts:5-9`). Only a route the catalog does not describe gets interrogated over the wire.
- Only `openai-completions` and `openai-responses` are interrogated. Every other protocol reports that it cannot be read, so the surface falls back to hand entry (`discovery.ts:38-41`).
- One request: `GET {baseURL}/models` (`discovery.ts:86-88`), 4 MiB response ceiling enforced on bytes actually read (`discovery.ts:50`, `readBounded` at `:96`).
- `readListing` (`discovery.ts:138-162`) reads exactly four things per entry: `id`, `name` or `display_name`, `context_window` or `context_length`, `max_output_tokens` or `max_tokens`.
- Entries with no usable `id` are skipped rather than failing the run.

## The bug this user is hitting right now

vLLM answers `GET /v1/models` with `max_model_len`. The `ListingEntry` interface at `discovery.ts:53-62` does not name that key, so the value is dropped on the floor.

Measured reply from `http://10.0.100.226:8000/v1/models`:

```json
{"object":"list","data":[{
  "id":"deepseek-v4-flash-vision-exp","object":"model","created":1785412064,
  "owned_by":"vllm","root":"deepseek-ai/DeepSeek-V4-Flash-Vision-Exp","parent":null,
  "max_model_len":1008128,
  "permission":[{"id":"modelperm-8e4e3e3035c3b8bc","object":"model_permission",
    "created":1785412064,"allow_create_engine":false,"allow_sampling":true,
    "allow_logprobs":true,"allow_search_indices":false,"allow_view":true,
    "allow_fine_tuning":false,"organization":"*","group":null,"is_blocking":false}]}]}
```

Entry keys, exactly: `id`, `object`, `created`, `owned_by`, `root`, `parent`, `max_model_len`, `permission`.

So today, fetching models from this gateway yields a row carrying nothing but the id. A 1,008,128-token context window is discarded from bytes already sitting in memory. The user then has to type it in by hand, or eat the adapter's 262,144 fallback (`DEFAULT_CONTEXT_WINDOW`, `config.ts:61`), which silently under-sizes a million-token model by 4x.

Adding `max_model_len` to the `capacity()` candidate list at `discovery.ts:152` is a one-line change that fixes this. Do it first. It is worth more than the rest of this document.

## What the gateway actually exposes

Measured against vLLM `0.25.2.dev0+g752a3a504.d20260714` at `10.0.100.226:8000`.

| Endpoint | Status | Body | Worth |
|---|---|---|---|
| `GET /v1/models` | 200 | full entry above | context window, upstream repo, identity |
| `GET /health` | 200 | empty, 0 bytes | liveness only |
| `GET /version` | 200 | `{"version":"0.25.2.dev0+g752a3a504.d20260714"}` | server build |
| `GET /load` | 200 | `{"server_load":0}` | current load |
| `GET /metrics` | 200 | Prometheus text, 75 KB here | cache config, queue depth, token counters |
| `POST /tokenize` | 200 | `{"count":2,"max_model_len":1008128,"tokens":[...]}` | tokenizer liveness, re-confirms max_model_len |
| `GET /v1/models/{id}` | 404 | `{"detail":"Not Found"}` | not supported |
| `GET /server_info`, `/get_server_info` | 404 | — | absent in this build |

Useful fields from `vllm:cache_config_info` gauge labels on this box: `block_size=4`, `cache_dtype=fp8`, `enable_prefix_caching=True`, `gpu_memory_utilization=0.85`, `kv_cache_size_tokens=667637`, `num_gpu_blocks=7706`, `prefix_caching_hash_algo=sha256`, `sliding_window=128`.

Read `sliding_window` with care before showing it to anyone. A value of 128 beside a 1,008,128 context window looks contradictory until you notice this is a hybrid-attention model with mamba cache keys alongside it. Do not derive a user-facing warning from that pair.

## What discovery cannot find out

Say this to the user rather than letting them discover it.

- **Per-request output cap.** Not advertised anywhere. `max_model_len` is the combined window, not the output ceiling. `maxTokens` still has to be declared.
- **Modalities.** Nothing in the API says whether the model takes images. The id says `vision`, which is a name, not a capability. `PiAiModelProfile.input` (`catalog.ts:559`) already warns that nothing interrogates a gateway for modalities and a wrong claim gets rejected mid-turn by the provider. Discovery cannot close that gap.
- **Reasoning support and levels.** Not advertised. `reasoningEfforts` still has to be declared.
- **Which sampling params the server honors.** Not advertised.

So discovery can prefill `contextWindow` and `name`, report server health and version, and nothing else that Part 1 asks the user to configure.

## Can a plugin do this? No.

Four hard blocks, each verified.

1. `registerModelDiscovery` throws `DUPLICATE_DISCOVERY` when the namespace is taken — `packages/llm/llm/src/index.ts:537-540`. `llm-pi-ai` registers `NS` at `packages/llm/llm-pi-ai/src/index.ts:254`. A plugin cannot replace or wrap it.
2. `LlmDiscoveredModel` has four fields — `packages/llm/llm/src/types.ts:221-230`.
3. The RPC wire schema `discoveredModelViewSchema` is a fixed `z.object` of those same four fields — `packages/host/apiproxy/src/api/llm.schema.ts:40-45`. Extra fields do not cross the boundary.
4. The RPC method map is a closed literal — `packages/host/apiproxy/src/api/rpc-map.ts`. A plugin cannot add methods, so there is no side channel for a richer fetch either.

Richer discovery is a core change across the same four layers as top_p: `dsh-llm` type, pi-ai discovery, apiproxy wire schema, client `adopt()`.

## CORS note, since it decides where the fetch runs

The gateway echoes `access-control-allow-origin: *` when the request carries an `Origin` header, and answers an `OPTIONS` preflight with `DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT` and a 600s max age. So a browser-side fetch works against this box today.

Do not build on that. It is a property of this deployment's uvicorn config, not of OpenAI-compatible gateways in general, and a gateway without it fails in the browser while working from the host. Host-side discovery is the right home. Worth knowing only because it means a quick browser-console probe is a legitimate way to inspect a gateway.

## Recommended core change

Widen `LlmDiscoveredModel` with optional fields only, so no existing adapter is forced to change:

- Keep `id`, `name`, `contextWindow`, `maxTokens`.
- Map `max_model_len` into `contextWindow` at `discovery.ts:152`. Highest value, lowest risk.
- `upstreamRoot?: string` from `root`. Tells the user which checkpoint their gateway actually serves.
- `createdAt?: number` from `created`.
- `serverVersion?: string` from `GET /version`.
- `healthy?: boolean` from `GET /health`.
- `capabilities?: string[]` for probed endpoints, so the UI can say what was checked and what was not.

Then in the client, `adopt()` at `ModelListEditor.tsx:147-154` maps discovered to draft. Show the new fields as read-only discovery metadata in the row's expanded panel. Do not make them draft fields, because they are not part of `PiAiModelProfile` and writing them into the profile would store values the adapter ignores.

Three rules for the extra probes:

- **Never map `max_model_len` to `maxTokens`.** They are different quantities. Capping output at the full window is wrong and can exceed the provider's own limit.
- **Run the extra probes in parallel with a short timeout, and honor `request.signal`.** The discovery contract already requires signal honoring (`discovery.ts:192`). A health check that hangs must not hang the fetch.
- **Do not fetch `/metrics` in the discovery path.** 75 KB idle here, and it grows with label cardinality on a busy server. It would blow past the 4 MiB ceiling in `readBounded` on a loaded box and turn a working endpoint into a `DISCOVERY_FAILED`. If you want cache config in the UI, put it behind an explicit user action with its own budget, not behind the model fetch.

## Part 2 verification

1. Replay the captured `/v1/models` JSON above through `readListing` in a unit test and assert `contextWindow === 1008128`. This is the regression that matters.
2. Assert `maxTokens` stays `undefined` for that entry. Proves you did not conflate the two quantities.
3. Point a test at a listing with `max_model_len` absent and confirm the row still comes back with just an id, unchanged from today.
4. Against the live gateway, confirm the fetch now shows the context window without the user typing it.
5. Confirm a `/health` timeout does not fail the model fetch.

---

## Open questions to settle with the user

- Does the RTX-Spark gateway actually accept `top_p` at the top level of `/v1/chat/completions`? vLLM does, but confirm with a curl before spending a core PR on it.
- Should the plugin also expose `top_k`? The user asked for temperature and top_p here but mentioned top_k earlier. Same core cost as top_p, same absence today. Ask before scoping it in.
- Should per-model temperature override an explicit mid-session `agent/request` change from another plugin, or lose to it? Waterfall order decides this and the answer is a product choice.
- Does the user want the phase 2 core PR attempted, or plugin-only with top_p deferred? Phase 2 touches both SDKs and needs an Agent Note.
- Part 2 is core-only work. Is the user willing to open a harness PR for it, or do they want the `max_model_len` gap reported as a bug and handled by the harness team separately from this plugin?
- If discovery reports `healthy` and `serverVersion`, where should that live? A read-only panel in the model row is the obvious answer, but the user may want it on the provider card instead.
- Should the plugin cache the last successful discovery per route so the UI can show staleness, or is a live fetch each time enough?
