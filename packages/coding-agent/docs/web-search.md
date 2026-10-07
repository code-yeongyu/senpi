# Web Search

The `web_search` tool searches the web and returns source URLs the model can cite. It works without any setup. With a `websearch.json` you choose the search providers yourself, and, when `auto` is on, the hosted web search of the model your session is already using goes first.

## Where the config lives

senpi reads the first `websearch.json` it finds, in this order:

1. `<project>/.senpi/websearch.json`
2. `<project>/.pi/websearch.json`
3. `~/websearch.json`
4. `~/.senpi/websearch.json`
5. `~/.pi/websearch.json`

`/websearch status` shows which config is active, the providers in routing order, the model native search runs on, and the route and model that served the last search.

## Without a config file

With no `websearch.json`, your search queries may be sent to DuckDuckGo and to Exa's hosted search service, and then to the other free engines below. senpi tries them in this order and stops at the first one that answers:

1. DuckDuckGo (its no-JavaScript results page)
2. Exa's hosted search service (`https://mcp.exa.ai/mcp`), used through its anonymous tier
3. Startpage
4. Mojeek
5. Ecosia
6. Google's results page

Each of these services receives the search query, plus any `site:` filters the model added. None of them receives a key, an account, your senpi session id, or any other part of the conversation.

This default never costs money: no paid API is called and no key is sent. When the session provider has hosted search, that native route still goes first (see [Native (hosted) search](#native-hosted-search)).

To keep searches away from these services, create a `websearch.json` (see [Limit or turn off the free engines](#limit-or-turn-off-the-free-engines)).

The results pages are fetched with a plain HTTP request. Search sites defend themselves against automated traffic, and some of them answer with a bot check (a CAPTCHA, a proof-of-work page, a "JavaScript required" wall, or DuckDuckGo's "anomaly" page) instead of results. senpi does not run a browser to pass these checks. It recognizes the check page, reports it as a challenge, and moves on to the next engine. Which engines answer depends on your network: a home connection usually gets DuckDuckGo results, while shared or datacenter addresses are challenged more often.

### Cooldown after a block

When a free engine blocks a search (a bot check, HTTP 429 or 403, or a network error), senpi stops asking it for a while:

- the first block pauses the engine for 1 minute;
- each further block in a row doubles the pause, up to 15 minutes;
- a `Retry-After` header can lengthen the pause, never beyond 15 minutes;
- one successful answer clears it.

The pause lasts for the session. Paused engines still appear in the result's routing line, for example:

```text
Routing attempts: duckduckgo-html skipped (cooling down for 42s after a bot challenge) -> exa-mcp failed: Search failed with HTTP 429: rate limited -> startpage challenged: Startpage served a bot challenge (proof-of-work interstitial) that needs a browser to pass. -> mojeek 10 results
```

Providers that need a key (Brave, Tavily, Exa with a key, and so on) and native routes are never paused this way; their errors are reported and the next provider is tried as before.

## websearch.json

A config file replaces the free default completely: senpi uses only the providers the file lists (plus the model's own web search when `auto` is on).

```json
{
  "strategy": "priority",
  "fallback": true,
  "auto": true,
  "providers": [
    { "provider": "searxng", "baseUrl": "http://localhost:8888" },
    { "provider": "duckduckgo-html" },
    { "provider": "brave", "apiKey": "<your Brave Search key>" }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `strategy` | `priority` (default) tries providers in list order, or by their `priority` number. `round-robin` rotates the first provider on each search (`weight` repeats a provider in the rotation). `fill-first` merges results from several providers, removing duplicate URLs, until `maxResults` is reached. |
| `fallback` | `true` (default) moves on to the next provider when one fails. |
| `auto` | `true` (default) puts the chat model's own web search first when it has one. |
| `nativeModel` | The model native search runs on; see [Choosing the model native search runs on](#choosing-the-model-native-search-runs-on). |
| `providers[]` | The providers to use. Each entry takes `provider`, and optionally `id`, `apiKey`, `baseUrl`, `maxResults`, `timeoutMs`, `priority`, `weight`, `allowedDomains` or `blockedDomains`. |

Free engines you can list without a key: `duckduckgo-html`, `exa-mcp`, `startpage`, `mojeek`, `ecosia`, `google-html`, `searxng`, and `keenable`. Providers that need `apiKey`: `exa`, `tavily`, `brave`, `serper`, `serpdive`, `kagi`, `perplexity`, `z-ai`, `xai`, `kimi`, `deepseek`, `anthropic`, `openai` (plus `searchEngineId` for `google-cse`). `chatgpt-subscription` and `google` use your senpi login when `apiKey` is omitted; see [Listing login-based routes](#listing-login-based-routes).

`keenable` ([Keenable](https://keenable.ai)) takes an `apiKey` but also works without one: a keyed entry posts to `https://api.keenable.ai/v1/search` with `X-API-Key`, while a keyless entry uses the shared public tier at `/v1/search/public` and identifies itself with an `X-Keenable-Title` app header instead of a credential. Because the public tier is a per-IP pool, `keenable` is never in the no-config default chain — list it explicitly in `websearch.json`. A single `allowedDomains` entry maps to Keenable's native `site` filter; multiple or blocked domains stay `site:`/`-site:` terms in the query.

## Limit or turn off the free engines

A `websearch.json` replaces the free chain completely, so the engines it does not list are never contacted. Put the file in `~/.senpi/websearch.json` to apply it everywhere, or in `<project>/.senpi/websearch.json` for one project.

DuckDuckGo only:

```json
{
  "providers": [{ "provider": "duckduckgo-html" }]
}
```

Only your own providers (here a self-hosted SearXNG instance and a Brave Search key), with no free public engine:

```json
{
  "providers": [
    { "provider": "searxng", "baseUrl": "http://localhost:8888" },
    { "provider": "brave", "apiKey": "<your Brave Search key>" }
  ]
}
```

With `auto` on (the default), the model you are chatting with still searches through its own provider first when it has built-in web search. Add `"auto": false` to use only the providers listed in the file:

```json
{
  "auto": false,
  "providers": [{ "provider": "searxng", "baseUrl": "http://localhost:8888" }]
}
```

## Self-hosted SearXNG

[SearXNG](https://docs.searxng.org/) is a metasearch engine you can run yourself. senpi queries its JSON API:

```json
{
  "providers": [
    { "provider": "searxng", "baseUrl": "http://localhost:8888" },
    { "provider": "duckduckgo-html" },
    { "provider": "exa-mcp" }
  ]
}
```

- `baseUrl` is the address of your instance, including any path prefix (`https://example.org/searx`). senpi appends `/search?q=...&format=json`.
- The instance must allow the JSON format. In its `settings.yml`, list it under `search.formats`:

  ```yaml
  search:
    formats:
      - html
      - json
  ```

- A plain `http://` address is accepted only for a host on your own network: `localhost`, a private address such as `192.168.x.x` or `10.x.x.x`, a single-word host name such as a Docker service name, or a `.local`, `.lan`, `.internal` or `.home.arpa` name. Any other host must use `https://`, so your queries never cross the internet unencrypted. Addresses with a user name or password are rejected. Every other provider still requires a public `https://` address.

## Native (hosted) search

When `auto` is `true` (the default), senpi puts a native entry in front of your configured providers, or in front of the free chain when there is no config file. That entry calls the hosted web search of the session's own provider (Anthropic Messages or OpenAI Responses compatible endpoints, the ChatGPT subscription, xAI, DeepSeek, Perplexity, Z.AI, Kimi Code) with the session's own credential. Google Search grounding is never added this way; it is opt-in (see below). Sessions on the first-party Anthropic and OpenAI APIs instead get the provider's server-side search tool in the main request, and `web_search` stays out of the way there.

### Choosing the model native search runs on

A search sub-request only has to find URLs, so it does not need the session's top-tier model. `nativeModel` picks the model it runs on:

```json
{
  "nativeModel": "claude-haiku-4-5",
  "providers": [{ "provider": "duckduckgo-html" }]
}
```

- The value is a model id (or `provider/id`) served by the **same provider, endpoint and credential** as the session model. Native search never switches to another provider or account because of this setting.
- A model that is not on the session's route is ignored: native search uses the session model, and `/websearch status` shows a warning naming the ignored value.
- If the chosen model fails (an HTTP error such as an unknown model, or no search results), the same search is retried on the session model before routing moves on to the next provider. This retry happens even with `"fallback": false`, because it stays on the same route.
- `"nativeModel": "session"` always uses the session model.

### Default search model

Without `nativeModel`, senpi uses the provider's cheaper search model from this table:

| Session route (native mapping) | Default search model |
| --- | --- |
| Anthropic Messages (Claude models, first-party or compatible endpoint) | `claude-haiku-4-5` (or `claude-haiku-4.5` where the provider spells it that way) |
| OpenAI Responses (GPT-5 models, first-party or compatible endpoint) | `gpt-5.6-luna` |
| xAI (Grok models) | `grok-4.3` |
| DeepSeek (`deepseek-v4-*` models) | `deepseek-v4-flash` |
| ChatGPT subscription, Perplexity, Z.AI, Kimi Code, OpenRouter | none: the session model is used |

The default model is used only when all of these hold:

- your model list includes it on the **same provider and endpoint** as the session model, so the search uses the same login;
- its listed price is no higher than the session model's for input and output tokens, and lower for at least one of them;
- it is not the session model itself.

Otherwise, including when prices are not listed (for example a custom provider whose models have zero cost), the session model is used as before. Either way a failed or empty search retries on the session model. `"nativeModel": "session"` turns the default off.

The routing attempts line of each result names the model behind every attempt, for example:

```text
Routing attempts: my-proxy/native (claude-haiku-4-5) failed: Search failed with HTTP 404: model not found -> my-proxy/native (claude-opus-4-5) 5 results
```

### ChatGPT subscription route

The search goes to the subscription's web search tool with your ChatGPT login. A reply counts only when the model actually ran a web search: results come from that search's sources and from the citations in the answer. URLs the model writes in its answer text are never returned as sources. Small realtime models (the `-spark` variants) have no search route.

The `codex` provider id is a separate thing: it calls OpenAI's pay-as-you-go Responses API and needs an `apiKey`.

## Google Search grounding (opt-in)

Google Search grounding runs only when you list a `google` entry in `websearch.json`, because Google bills grounding beyond its free allowance. A Google model session without that entry gets no Google Search grounding.

The search calls `generateContent` with the `google_search` tool. Results are the grounding sources Google returns; an answer without grounding sources counts as no results. Each result URL is Google's grounding redirect link, which forwards to the source page, and the title is usually the source's site name.

A `google` entry without `apiKey` uses your senpi `google` login (Google API key) and a Google model from it; set `model` to choose one. Vertex AI logins are not used.

## Listing login-based routes

List a `google` entry in `websearch.json` to turn on Google Search grounding, or a `chatgpt-subscription` entry to use that login from a session running another provider. Without an `apiKey`, the entry uses the matching senpi login and always sends it to that login's own endpoint; a `baseUrl` on such an entry is ignored. If you have no matching login, senpi skips the entry.

```json
{
  "providers": [
    { "id": "subscription", "provider": "chatgpt-subscription" },
    { "id": "google", "provider": "google" },
    { "id": "free", "provider": "duckduckgo-html" }
  ]
}
```

A `google` entry may also carry its own `apiKey` and `model`. Listing `chatgpt-subscription` is only needed to use that login from a session running another provider.

## Cost

- The ChatGPT subscription route counts against your subscription's usage limits. It does not bill an API account.
- Google Search grounding is opt-in. It may be billed by Google at its grounding price once you pass the free allowance; check Google's pricing for your plan.
- Other session routes bill the session's own provider account. The free engines (see [Without a config file](#without-a-config-file)) cost nothing.
