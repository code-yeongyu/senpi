import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { streamInternalModel } from "../../src/core/internal-model-request.ts";
import { lazyStream } from "@earendil-works/pi-ai";
import { generateSessionTitle } from "../../src/core/session-title-generator.ts";
import { completeSummarization } from "../../src/core/compaction/compaction.ts";
import { generateSummaryMessage } from "../../src/core/extensions/builtin/compaction/speculative-summary.ts";
import { runOpenAiRemoteCompaction } from "../../src/core/extensions/builtin/compaction/openai-remote.ts";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "../../src/index.ts";
import { subscribeAccountSwitch } from "../../src/core/credential-pool/account-notices.ts";
import btwExtension from "../../src/core/extensions/builtin/btw/index.ts";
import { runLookAt } from "../../src/core/extensions/builtin/look-at/runner.ts";
import { generateBranchSummary } from "../../src/core/compaction/branch-summarization.ts";

const fallbackSettings = {
  retry: { enabled: true, maxRetries: 0, modelFallback: true, fallbackRevertPolicy: "never",
    fallbackChains: { "chatgpt-subscription/gpt-6-astra": ["openrouter/deepseek/deepseek-v4-pro-0813:max"] } },
};

const token = (name) => `test.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: name },
})).toString("base64url")}.test`;
const usage = (used) => ({
  rate_limit: { allowed: used < 100, limit_reached: used >= 100, primary_window: { used_percent: used } },
  credits: { has_credits: false, balance: "0" },
});
const context = {
  systemPrompt: "Return a short summary.",
  messages: [{ role: "user", content: "Repair the account selector.", timestamp: 1 }],
};

async function fixture(t, allExhausted = false) {
  const dir = mkdtempSync(join(tmpdir(), "omo-auxiliary-"));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "settings.json"), JSON.stringify(fallbackSettings));
  const accounts = ["exhausted", "ready"].map((name) => ({
    name, access: token(name), refresh: `test-refresh-${name}`, expires: 9e12,
  }));
  const credentials = AuthStorage.inMemory({
    "chatgpt-subscription": { type: "oauth", ...accounts[0], pinned: "exhausted", accounts },
    openrouter: { type: "api_key", key: "test-openrouter-key" },
  });
  const runtime = await ModelRuntime.create({ credentials, agentDir: dir, modelsPath: null, allowModelNetwork: false });
  const attempts = [];
  const attemptedModels = [];
  const provider = runtime.getProvider("chatgpt-subscription");
  const produce = (model, _context, options) => {
    attempts.push(options.apiKey);
    attemptedModels.push(`${model.provider}/${model.id}`);
    const message = {
      role: "assistant", provider: model.provider, api: model.api, model: model.id,
      content: [{ type: "text", text: "<title>Account Routing Repaired</title>" }],
      stopReason: "stop", timestamp: 1,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    return lazyStream(model, async () => {
      await options.onPayload?.({}, model);
      return (async function* () {
        yield { type: "text_delta", contentIndex: 0, delta: message.content[0].text, partial: message };
        yield { type: "done", reason: "stop", message };
      })();
    });
  };
  await runtime.registerNativeProvider({ ...provider, stream: produce, streamSimple: produce }, { refresh: false });
  await runtime.registerNativeProvider({
    ...runtime.getProvider("openrouter"), stream: produce, streamSimple: produce,
  }, { refresh: false });
  const resolveSources = runtime.credentialRotationSources.bind(runtime);
  runtime.credentialRotationSources = async (model, options) => {
    const sources = await resolveSources(model, options);
    if (sources) sources.getCodexUsage = async (slot) => usage(allExhausted || slot.name === "exhausted" ? 100 : 0);
    return sources;
  };
  return { runtime, model: runtime.getModel("chatgpt-subscription", "gpt-6-astra"), attempts, attemptedModels, dir, credentials };
}

async function makeSession(t, f) {
  const settingsManager = SettingsManager.inMemory(fallbackSettings);
  const resourceLoader = new DefaultResourceLoader({
    cwd: f.dir, agentDir: f.dir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: "Reply briefly.",
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: f.dir, agentDir: f.dir, modelRuntime: f.runtime, authStorage: f.credentials,
    settingsManager, resourceLoader, model: f.model,
    sessionManager: SessionManager.inMemory(), noTools: "all",
  });
  t.onTestFinished(() => session.dispose());
  return session;
}

test("title generation rotates away from its pre-resolved exhausted OAuth token", async (t) => {
  const f = await fixture(t);
  const title = await generateSessionTitle({
    model: f.model, firstPrompt: "Repair the credential account selector",
    auth: { apiKey: token("exhausted") }, sessionId: "title-test",
    streamFn: (model, context, options) => streamInternalModel(f.runtime, model, context, options, { settings: SettingsManager.inMemory(fallbackSettings), agentDir: f.dir }),
    retry: { enabled: true, maxRetries: 0, baseDelayMs: 0 },
  });
  assert.ok(title);
  assert.deepEqual(f.attempts, [token("ready")]);
});

test("compaction rotates even when summary options contain a resolved OAuth token", async (t) => {
  const f = await fixture(t);
  await completeSummarization(f.model, context,
    { apiKey: token("exhausted"), affinitySessionId: "compaction-test" },
    (model, context, options) => streamInternalModel(f.runtime, model, context, options, { settings: SettingsManager.inMemory(fallbackSettings), agentDir: f.dir }),
    { enabled: true, maxRetries: 0, baseDelayMs: 0 });
  assert.deepEqual(f.attempts, [token("ready")]);
});

test("speculative compaction uses account admission on the typed stream path", async (t) => {
  const f = await fixture(t);
  const result = await generateSummaryMessage({
    context: { agentDir: f.dir, cwd: f.dir, getRetryFallbackSettings: () => SettingsManager.inMemory(fallbackSettings).getRetryFallbackSettings(), modelRegistry: { modelRuntime: f.runtime } },
    snapshot: { model: f.model, contextWindow: f.model.contextWindow, systemPrompt: "Summarize." },
    auth: { apiKey: token("exhausted") },
    messages: context.messages,
    prompt: { system: "Summarize.", user: "Summarize the request." },
  });
  assert.ok(result);
  assert.deepEqual(f.attempts, [token("ready")]);
});

test("an unrelated explicit credential still bypasses the stored account pool", async (t) => {
  const f = await fixture(t);
  await f.runtime.completeSimple(f.model, context, { apiKey: token("external") });
  assert.deepEqual(f.attempts, [token("external")]);
});

test("an explicit stored credential remains pinned instead of silently rotating", async (t) => {
  const f = await fixture(t);
  await f.runtime.completeSimple(f.model, context, { apiKey: token("exhausted") });
  assert.deepEqual(f.attempts, [token("exhausted")]);
});

test("native title generation uses the configured model fallback after account exhaustion", async (t) => {
  const f = await fixture(t, true);
  const session = await makeSession(t, f);
  await session._generateSessionTitle("Repair credential account selection", f.model, new AbortController());
  assert.ok(session.sessionManager.getSessionName());
  assert.deepEqual(f.attemptedModels, ["openrouter/deepseek/deepseek-v4-pro-0813"]);
  assert.equal(session.model.provider, "chatgpt-subscription");
});

test("speculative summary uses the configured model fallback without Codex generation", async (t) => {
  const f = await fixture(t, true);
  const result = await generateSummaryMessage({
    context: { agentDir: f.dir, cwd: f.dir, getRetryFallbackSettings: () => SettingsManager.inMemory(fallbackSettings).getRetryFallbackSettings(), modelRegistry: { modelRuntime: f.runtime } },
    snapshot: { model: f.model, contextWindow: f.model.contextWindow, systemPrompt: "Summarize." },
    auth: { apiKey: token("exhausted") }, messages: context.messages,
    prompt: { system: "Summarize.", user: "Summarize the request." },
  });
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(f.attemptedModels, ["openrouter/deepseek/deepseek-v4-pro-0813"]);
});

test("remote Codex compaction uses a quota-eligible account on the HTTP endpoint", async (t) => {
  const f = await fixture(t);
  const seenAccounts = [];
  const result = await runOpenAiRemoteCompaction({
    model: f.model,
    modelRegistry: {
      modelRuntime: f.runtime,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token("exhausted") }),
    },
    getSystemPrompt: () => "Summarize.",
    sessionManager: { getSessionId: () => "remote-test" },
  }, {
    reason: "manual", requestId: "remote-request", signal: new AbortController().signal,
    branchEntries: [{ type: "message", id: "u", message: context.messages[0] }],
    preparation: { tokensBefore: 100, firstKeptEntryId: "u" },
  }, undefined, {
    fetch: async (_url, options) => {
      seenAccounts.push(new Headers(options.headers).get("chatgpt-account-id"));
      return Response.json({ output: [{ type: "compaction", encrypted_content: "test-checkpoint" }] });
    },
  });
  assert.ok(result);
  assert.deepEqual(seenAccounts, ["ready"]);
});

async function closeAfterTerminal(stream) {
  for await (const event of stream) {
    if (event.type === "error") throw new Error(event.error.errorMessage);
    if (event.type === "done") break;
  }
}

test("payload provenance uses the selected account rather than the stale auth snapshot", async (t) => {
  const f = await fixture(t);
  let headers;
  await closeAfterTerminal(streamInternalModel(f.runtime, f.model, context, {
    apiKey: token("exhausted"),
    onPayload: (_payload, _model, metadata) => { headers = new Headers(metadata.headers); },
  }, { settings: SettingsManager.inMemory(fallbackSettings), agentDir: f.dir }));
  assert.equal(headers.get("chatgpt-account-id"), "ready");
  assert.equal(headers.get("authorization"), `Bearer ${token("ready")}`);
});

test("remote compaction returns control to local fallback when every account is exhausted", async (t) => {
  const f = await fixture(t, true);
  const events = [];
  let requests = 0;
  const result = await runOpenAiRemoteCompaction({
    model: f.model,
    modelRegistry: {
      modelRuntime: f.runtime,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token("exhausted") }),
    },
    getSystemPrompt: () => "Summarize.",
    sessionManager: { getSessionId: () => "remote-exhausted-test" },
  }, {
    reason: "manual", requestId: "remote-exhausted", signal: new AbortController().signal,
    branchEntries: [{ type: "message", id: "u", message: context.messages[0] }],
    preparation: { tokensBefore: 100, firstKeptEntryId: "u" },
  }, (event) => events.push(event), {
    fetch: async () => { requests += 1; throw new Error("Unexpected compact endpoint request"); },
  });
  assert.equal(result, undefined);
  assert.equal(requests, 0);
  assert.ok(events.some((event) => event.action === "remote_fallback"));
});

function remoteRequest(f, model, runtime, fetchImpl) {
  return runOpenAiRemoteCompaction({
    model,
    modelRegistry: {
      modelRuntime: runtime,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token("exhausted") }),
    },
    getSystemPrompt: () => "Summarize.",
    sessionManager: { getSessionId: () => "remote-errors-test" },
  }, {
    reason: "manual", requestId: "remote-errors", signal: new AbortController().signal,
    branchEntries: [{ type: "message", id: "u", message: context.messages[0] }],
    preparation: { tokensBefore: 100, firstKeptEntryId: "u" },
  }, undefined, { fetch: fetchImpl });
}

for (const provider of ["chatgpt-subscription", "openai"]) {
  for (const status of [401, 402, 403, 429]) {
    test(`legacy ${provider} remote HTTP ${status} preserves local fallback`, async (t) => {
      const f = await fixture(t);
      const model = provider === "chatgpt-subscription" ? f.model : {
        ...f.model, provider, api: "openai-responses", baseUrl: "https://example.invalid/v1",
        compat: { supportsWebSocket: false, supportsRemoteCompactionV2: false },
      };
      let requests = 0;
      const result = await remoteRequest(f, model, {
        streamSimple() { throw new Error("Unexpected streaming call"); },
      }, async () => {
        requests += 1;
        return new Response("synthetic account rejection", { status });
      });
      assert.equal(result, undefined);
      assert.equal(requests, 1);
    });
  }
}

for (const status of [401, 429]) {
  test(`rotating remote HTTP ${status} still tries the healthy peer`, async (t) => {
    const f = await fixture(t);
    const resolveSources = f.runtime.credentialRotationSources.bind(f.runtime);
    f.runtime.credentialRotationSources = async (model, options) => {
      const sources = await resolveSources(model, options);
      if (sources) sources.getCodexUsage = async () => usage(20);
      return sources;
    };
    const attempts = [];
    const result = await remoteRequest(f, f.model, f.runtime, async (_url, options) => {
      const account = new Headers(options.headers).get("chatgpt-account-id");
      attempts.push(account);
      return account === "exhausted"
        ? new Response("synthetic account rejection", { status })
        : Response.json({ output: [{ type: "compaction", encrypted_content: "test-checkpoint" }] });
    });
    assert.ok(result);
    assert.deepEqual(attempts, ["exhausted", "ready"]);
  });
}

test("account fallback emits one sanitized notice, not another notice each request", async (t) => {
  const f = await fixture(t);
  const events = [];
  const unsubscribe = subscribeAccountSwitch((event) => events.push(event));
  t.onTestFinished(unsubscribe);
  const options = { sessionId: "account-notice-test", purpose: "title", apiKey: token("exhausted") };
  await closeAfterTerminal(streamInternalModel(f.runtime, f.model, context, options, { settings: SettingsManager.inMemory(fallbackSettings), agentDir: f.dir }));
  await closeAfterTerminal(streamInternalModel(f.runtime, f.model, context, options, { settings: SettingsManager.inMemory(fallbackSettings), agentDir: f.dir }));
  assert.equal(events.length, 1);
  assert.equal(events[0].from, "exhausted");
  assert.equal(events[0].to, "ready");
  assert.equal(events[0].source, "title");
  assert.equal(events[0].sessionId, "account-notice-test");
  assert.match(events[0].reason, /quota/);
  assert.equal(JSON.stringify(events).includes(token("exhausted")), false);
  assert.equal(JSON.stringify(events).includes(token("ready")), false);
});

test("the native side-query command falls back without changing the main model", async (t) => {
  const f = await fixture(t, true);
  let command;
  const notices = [];
  btwExtension({
    on() {},
    getThinkingLevel: () => "low",
    registerCommand: (_name, definition) => { command = definition; },
  });
  const ctx = {
    getRetryFallbackSettings: () => SettingsManager.inMemory(fallbackSettings).getRetryFallbackSettings(),
    model: f.model, agentDir: f.dir, cwd: f.dir, mode: "print", hasUI: false,
    getSystemPrompt: () => "Reply briefly.",
    sessionManager: { getEntries: () => [], getLeafId: () => null, getSessionId: () => "side-query-test" },
    modelRegistry: {
      modelRuntime: f.runtime,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token("exhausted") }),
    },
    ui: { notify: (message, kind) => notices.push({ message, kind }) },
  };
  await command.handler("Which account can serve this request?", ctx);
  assert.deepEqual(f.attemptedModels, ["openrouter/deepseek/deepseek-v4-pro-0813"]);
  assert.equal(ctx.model.provider, "chatgpt-subscription");
  assert.equal(notices.some((notice) => notice.kind === "error"), false);
  assert.ok(notices.some((notice) => notice.kind === "info" && notice.message.length > 0));
});

const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";
function visionContext(f) {
  return {
    agentDir: f.dir, cwd: f.dir,
    getRetryFallbackSettings: () => SettingsManager.inMemory(fallbackSettings).getRetryFallbackSettings(),
    getImageSettings: () => ({ blockImages: false, autoResize: false }),
    getLookAtSettings: () => ({ models: ["chatgpt-subscription/gpt-6-astra:low"] }),
    sessionManager: { getSessionId: () => "vision-test" },
    modelRegistry: {
      modelRuntime: f.runtime, getAvailable: () => [f.model],
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token("exhausted") }),
    },
    ui: { notify() {} },
  };
}

test("native vision analysis skips an exhausted account", async (t) => {
  const f = await fixture(t);
  const result = await runLookAt({ image_data: pixel, goal: "Describe the image" },
    undefined, visionContext(f), { getOverride: () => ({}) });
  assert.ok(result.text);
  assert.deepEqual(f.attempts, [token("ready")]);
});

test("vision fallback never sends image input to a text-only fallback model", async (t) => {
  const f = await fixture(t, true);
  await assert.rejects(runLookAt({ image_data: pixel, goal: "Describe the image" },
    undefined, visionContext(f), { getOverride: () => ({}) }), /No credential slots available/);
  assert.deepEqual(f.attemptedModels, []);
});

test("native branch summaries use the internal model fallback after account exhaustion", async (t) => {
  const f = await fixture(t, true);
  const session = await makeSession(t, f);
  const result = await generateBranchSummary([
    { type: "message", id: "u", parentId: null, message: context.messages[0] },
  ], {
    model: f.model, apiKey: token("exhausted"), reserveTokens: 512,
    streamFn: (model, request, options) => session._streamInternalModel(model, request, options, "branch summary"),
    retry: { enabled: true, maxRetries: 0, baseDelayMs: 0 },
  });
  assert.ok(result.summary);
  assert.equal(result.error, undefined);
  assert.deepEqual(f.attemptedModels, ["openrouter/deepseek/deepseek-v4-pro-0813"]);
});
