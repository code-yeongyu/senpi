/**
 * Task-13 manual QA driver (secret-free, sandboxed).
 *
 * Drives the REAL per-connection RPC core (createRpcConnectionHandler — the exact
 * code an RPC client connects to) against a real AgentSession + real AuthStorage that
 * writes ONLY to a throwaway SENPI_CODING_AGENT_DIR. OAuth is stubbed (no real
 * server, clearly-fake tokens). It prints machine-checkable observables:
 *
 *   happy   — /login: get_auth_providers -> login_start -> auth_login_url event
 *             -> stub flow persists a FAKE oauth credential -> auth_login_end
 *             success -> auth.json exists at 0600 in the SANDBOX dir.
 *   failure — login_cancel mid-flow (aborted -> auth_login_end success:false) and
 *             an "oauth port busy" login failure (clean error, no crash).
 *
 * It NEVER touches the real ~/.senpi: SENPI_CODING_AGENT_DIR is redirected before
 * anything loads, and the driver refuses to run if that dir is the real one.
 *
 * Run: SENPI_CODING_AGENT_DIR=$(mktemp -d) npx tsx test/manual-qa/task13-auth-qa.mts
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai/compat";
import { AgentSession } from "../../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createRpcConnectionHandler, type RpcConnectionSink } from "../../src/modes/rpc/connection-handler.ts";
import { createTestResourceLoader } from "../utilities.ts";

const sandbox = process.env.SENPI_CODING_AGENT_DIR ?? join(tmpdir(), `t13-qa-${Date.now()}`);
mkdirSync(sandbox, { recursive: true });
const realSenpi = join(homedir(), ".senpi");
if (sandbox.startsWith(realSenpi)) {
	console.error(`REFUSING: sandbox ${sandbox} is inside the real ~/.senpi`);
	process.exit(2);
}

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(e) => e.type === "done" || e.type === "error",
			(e) => {
				if (e.type === "done") return e.message;
				if (e.type === "error") return e.error;
				throw new Error("unexpected");
			},
		);
	}
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

const authPath = join(sandbox, "auth.json");
const model = getModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("model not found");
const agent = new Agent({
	getApiKey: () => "test-key",
	initialState: { model, systemPrompt: "Test", tools: [] },
	streamFn: () => {
		const s = new MockAssistantStream();
		queueMicrotask(() => {
			s.push({ type: "start", partial: assistantMessage("") });
			s.push({ type: "done", reason: "stop", message: assistantMessage("done") });
		});
		return s;
	},
});
const authStorage = AuthStorage.create(authPath);
authStorage.setRuntimeApiKey("anthropic", "test-key");
const modelRegistry = ModelRegistry.create(authStorage, sandbox);
const session = new AgentSession({
	agent,
	sessionManager: SessionManager.inMemory(),
	settingsManager: SettingsManager.create(sandbox, sandbox),
	cwd: sandbox,
	modelRegistry,
	resourceLoader: createTestResourceLoader(),
});
const runtimeHost = {
	session,
	newSession: async () => ({ cancelled: true }),
	switchSession: async () => ({ cancelled: true }),
	fork: async () => ({ cancelled: true, selectedText: "" }),
	dispose: async () => {},
	setRebindSession: () => {},
} as unknown as AgentSessionRuntime;

const lines: string[] = [];
const sink: RpcConnectionSink = { writeRaw: (c) => lines.push(c), waitForBackpressure: async () => {} };
const msgs = () => lines.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
const flush = () => new Promise((r) => setTimeout(r, 10));

async function main(): Promise<void> {
	const handler = createRpcConnectionHandler(runtimeHost, sink, { capabilities: ["custom_unsupported"] });
	await handler.ready;

	console.log("=== SANDBOX ===", sandbox);

	// --- HAPPY: get_auth_providers ---
	await handler.handleInputLine(JSON.stringify({ id: "p", type: "get_auth_providers" }));
	const providers = (msgs().find((m) => m.command === "get_auth_providers")?.data as { providers: unknown[] })?.providers ?? [];
	console.log(`HAPPY get_auth_providers: ${providers.length} providers (anthropic present: ${providers.some((p) => (p as { id: string }).id === "anthropic")})`);

	// --- HAPPY: login_start with a STUBBED oauth login (fake credentials) ---
	const origLogin = authStorage.login.bind(authStorage);
	authStorage.login = async (providerId, callbacks) => {
		callbacks.onAuth({ url: "https://stub.example/oauth?code=FAKE" });
		authStorage.set(providerId, { type: "oauth", access: "FAKE-ACCESS", refresh: "FAKE-REFRESH", expires: Date.now() + 3_600_000 });
	};
	await handler.handleInputLine(JSON.stringify({ id: "l", type: "login_start", provider: "anthropic" }));
	await flush();
	const urlEv = msgs().find((m) => m.type === "auth_login_url");
	const endEv = msgs().find((m) => m.type === "auth_login_end");
	console.log(`HAPPY login_start response: ${msgs().find((m) => m.id === "l")?.success}`);
	console.log(`HAPPY auth_login_url: provider=${urlEv?.provider} url=${urlEv?.url}`);
	console.log(`HAPPY auth_login_end: provider=${endEv?.provider} success=${endEv?.success}`);
	const mode = statSync(authPath).mode & 0o777;
	console.log(`HAPPY auth.json exists=${existsSync(authPath)} mode=0${mode.toString(8)} (want 0600)`);
	const stored = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, { type: string }>;
	console.log(`HAPPY auth.json anthropic type=${stored.anthropic?.type} (secret-free evidence: value NOT printed)`);
	authStorage.login = origLogin;

	// --- FAILURE: login_cancel mid-flow (a login that hangs until aborted) ---
	lines.length = 0;
	authStorage.login = async (_p, callbacks) => {
		callbacks.onAuth({ url: "https://stub.example/oauth?code=PENDING" });
		await new Promise<void>((_res, rej) => callbacks.signal?.addEventListener("abort", () => rej(new Error("Login cancelled")), { once: true }));
	};
	await handler.handleInputLine(JSON.stringify({ id: "l2", type: "login_start", provider: "openai" }));
	await flush();
	await handler.handleInputLine(JSON.stringify({ id: "c", type: "login_cancel", provider: "openai" }));
	await flush();
	const cancelEnd = msgs().find((m) => m.type === "auth_login_end");
	console.log(`FAILURE login_cancel: response=${msgs().find((m) => m.id === "c")?.success} auth_login_end.success=${cancelEnd?.success}`);
	authStorage.login = origLogin;

	// --- FAILURE: oauth port busy (login throws) ---
	lines.length = 0;
	authStorage.login = async () => {
		throw new Error("oauth callback server: address already in use");
	};
	await handler.handleInputLine(JSON.stringify({ id: "l3", type: "login_start", provider: "openai" }));
	await flush();
	const busyEnd = msgs().find((m) => m.type === "auth_login_end");
	console.log(`FAILURE port-busy: auth_login_end.success=${busyEnd?.success} error=${JSON.stringify(busyEnd?.error)}`);
	authStorage.login = origLogin;

	await handler.dispose();
	console.log("=== DONE ===");
}

main().then(
	() => {
		// Clean up the sandbox we created (only if we made an ephemeral one).
		if (!process.env.SENPI_CODING_AGENT_DIR) rmSync(sandbox, { recursive: true, force: true });
		process.exit(0);
	},
	(err) => {
		console.error("QA FAILED:", err);
		process.exit(1);
	},
);
