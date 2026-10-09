import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, expect, it } from "vitest";
import {
	type AgentSessionRuntime,
	applyRetryFallbackProfile,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createRpcConnectionHandler, type RpcConnectionHandler } from "../../src/modes/rpc/connection-handler.ts";

// A task child spawned as its own `--mode rpc` process gets its category's fallback chain over the wire
// (omo#9582): no open_session there, and never through the user's settings file.

const USAGE_LIMIT = "You've hit your session limit · resets 3pm";
const USER_SETTINGS = { retry: { enabled: true, baseDelayMs: 1, maxRetries: 0 }, defaultThinkingLevel: "off" };
const CHILD_CHAIN = { modelFallback: true, fallbackChains: { "faux-fallback/primary": ["faux-fallback/spare"] } };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

interface SingleProcess {
	readonly runtime: AgentSessionRuntime;
	readonly settingsPath: string;
	request(command: Record<string, unknown>): Promise<Record<string, unknown>>;
	startPrompt(message: string): Promise<void>;
	/** Sends a prompt without waiting for it; the returned promise settles when that turn has ended. */
	sendPromptWithoutWaiting(message: string): Promise<void>;
	sendWithoutWaiting(command: Record<string, unknown>): void;
	lastAssistantText(): string;
}

async function singleRpcProcess(options: {
	retryFallbackCommand: boolean;
	firstTurnGate?: Promise<void>;
	/** Called when the first provider request reaches the gate, i.e. a turn is in flight. */
	onFirstTurnHeld?: () => void;
}): Promise<SingleProcess> {
	const dir = join(tmpdir(), `senpi-set-retry-fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	const settingsPath = join(dir, "settings.json");
	writeFileSync(settingsPath, `${JSON.stringify(USER_SETTINGS, null, 2)}\n`);

	const faux = registerFauxProvider({
		api: "faux-fallback",
		provider: "faux-fallback",
		models: [{ id: "primary" }, { id: "spare" }],
	});
	let gate = options.firstTurnGate;
	const step: FauxResponseStep = async (_context, _options, _state, model) => {
		const held = gate;
		gate = undefined;
		if (held !== undefined) {
			options.onFirstTurnHeld?.();
			await held;
		}
		return model.id === "primary"
			? fauxAssistantMessage("", { stopReason: "error", errorMessage: USAGE_LIMIT })
			: fauxAssistantMessage(`answered by ${model.id}`);
	};
	faux.setResponses(Array.from({ length: 12 }, () => step));
	const auth = AuthStorage.inMemory();
	await auth.modify("faux-fallback", async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({ credentials: auth, modelsPath: join(dir, "models.json") });
	modelRuntime.registerProvider("faux-fallback", {
		baseUrl: faux.models[0].baseUrl,
		api: faux.api,
		models: faux.models.map((model) => ({
			id: model.id,
			name: model.name,
			api: model.api,
			reasoning: model.reasoning,
			input: model.input,
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			baseUrl: model.baseUrl,
		})),
	});
	const primary = faux.getModel("primary");
	if (primary === undefined) throw new Error("faux primary model missing");

	// The same launch-profile step the CLI runtime factory takes (main.ts createServices).
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd,
		sessionManager,
		sessionStartEvent,
		launchProfile,
	}) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: dir,
			modelRuntime,
			resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true },
		});
		if (launchProfile?.retryFallback)
			applyRetryFallbackProfile(services.settingsManager, launchProfile.retryFallback);
		return {
			...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: primary })),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: dir,
		agentDir: dir,
		sessionManager: SessionManager.create(dir),
	});
	await runtime.session.bindExtensions({});

	const lines: Record<string, unknown>[] = [];
	const lineWaiters: Array<{
		readonly match: (line: Record<string, unknown>) => boolean;
		readonly resolve: () => void;
	}> = [];
	const nextLine = (match: (line: Record<string, unknown>) => boolean, label: string): Promise<void> =>
		new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`no ${label} line within 20s`)), 20_000);
			lineWaiters.push({
				match,
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
			});
		});
	const waiters = new Map<string, (line: Record<string, unknown>) => void>();
	const handler: RpcConnectionHandler = createRpcConnectionHandler(
		runtime,
		{
			writeRaw(chunk) {
				for (const text of chunk.split("\n")) {
					if (text.length === 0) continue;
					const line = JSON.parse(text) as Record<string, unknown>;
					lines.push(line);
					if (line.type === "response" && typeof line.id === "string") waiters.get(line.id)?.(line);
					for (const waiter of lineWaiters.splice(0)) {
						if (waiter.match(line)) waiter.resolve();
						else lineWaiters.push(waiter);
					}
				}
			},
			waitForBackpressure: async () => {},
		},
		{ retryFallbackCommand: options.retryFallbackCommand },
	);
	await handler.ready;
	cleanups.push(async () => {
		await handler.dispose();
		faux.unregister();
		rmSync(dir, { recursive: true, force: true });
	});

	let sequence = 0;
	return {
		runtime,
		settingsPath,
		sendWithoutWaiting(command) {
			void handler.handleInputLine(JSON.stringify({ ...command, id: `req-${++sequence}` }));
		},
		sendPromptWithoutWaiting(message) {
			const ended = nextLine((line) => line.type === "agent_end", "agent_end");
			void handler.handleInputLine(JSON.stringify({ type: "prompt", message, id: `req-${++sequence}` }));
			return ended;
		},
		async startPrompt(message) {
			const started = nextLine((line) => line.type === "agent_start", "agent_start");
			await handler.handleInputLine(JSON.stringify({ type: "prompt", message, id: `req-${++sequence}` }));
			await started;
		},
		async request(command) {
			const id = `req-${++sequence}`;
			const answered = new Promise<Record<string, unknown>>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`no response to ${String(command.type)}`)), 20_000);
				waiters.set(id, (line) => {
					clearTimeout(timer);
					resolve(line);
				});
			});
			await handler.handleInputLine(JSON.stringify({ ...command, id }));
			const response = await answered;
			if (command.type === "prompt") await runtime.session.waitForIdle();
			return response;
		},
		lastAssistantText() {
			const assistant = runtime.session.messages.filter((message) => message.role === "assistant").at(-1) as
				| { content?: Array<{ type: string; text?: string }>; errorMessage?: string }
				| undefined;
			return (
				assistant?.content?.find((block) => block.type === "text" && block.text)?.text ??
				assistant?.errorMessage ??
				""
			);
		},
	};
}

it("#given a single-process child told its chain before its first turn #when its model hits a usage limit #then it answers on the fallback and the settings file is untouched", async () => {
	// given
	const child = await singleRpcProcess({ retryFallbackCommand: true });
	const settingsBefore = readFileSync(child.settingsPath);
	const info = await child.request({ type: "get_protocol_info" });
	expect((info.data as { capabilities: string[] }).capabilities).toContain("retry_fallback_command");
	const set = await child.request({ type: "set_retry_fallback", retryFallback: CHILD_CHAIN });
	expect(set.success, String(set.error)).toBe(true);

	// when
	await child.request({ type: "prompt", message: "go" });

	// then
	expect(child.lastAssistantText()).toBe("answered by spare");
	expect(readFileSync(child.settingsPath)).toEqual(settingsBefore);
}, 60_000);

it("#given a single-process child never told a chain #when its model hits a usage limit #then it fails cleanly with the limit, as before", async () => {
	// given
	const child = await singleRpcProcess({ retryFallbackCommand: true });

	// when
	await child.request({ type: "prompt", message: "go" });

	// then
	expect(child.lastAssistantText()).toContain("session limit");
}, 60_000);

it("#given a child that has already run a turn #when a chain arrives #then it is refused and the chain it runs with does not change", async () => {
	// given
	const child = await singleRpcProcess({ retryFallbackCommand: true });
	await child.request({ type: "prompt", message: "go" });

	// when
	const late = await child.request({ type: "set_retry_fallback", retryFallback: CHILD_CHAIN });

	// then
	expect(late.success).toBe(false);
	expect(String(late.error)).toContain("before the session's first turn");
	expect(child.runtime.session.settingsManager.getRetryFallbackSettings().chains).not.toHaveProperty(
		"faux-fallback/primary",
	);
}, 60_000);

it("#given a child whose first turn is in flight #when a chain arrives #then it is refused and the turn finishes on the policy it started with", async () => {
	// given
	let release = () => {};
	const firstTurnGate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const child = await singleRpcProcess({ retryFallbackCommand: true, firstTurnGate });
	await child.startPrompt("go");

	// when
	const midTurn = await child.request({ type: "set_retry_fallback", retryFallback: CHILD_CHAIN });
	release();
	await child.runtime.session.waitForIdle();

	// then
	expect(midTurn.success).toBe(false);
	expect(String(midTurn.error)).toContain("before the session's first turn");
	expect(child.lastAssistantText()).toContain("session limit");
}, 60_000);

it("#given a prompt that was just accepted #when a chain arrives right behind it #then it is refused: the turn it would change has begun", async () => {
	// given
	const child = await singleRpcProcess({ retryFallbackCommand: true });
	const turnEnded = child.sendPromptWithoutWaiting("go");

	// when
	const behind = await child.request({ type: "set_retry_fallback", retryFallback: CHILD_CHAIN });
	await turnEnded;
	await child.runtime.session.waitForIdle();

	// then
	expect(behind.success).toBe(false);
	expect(child.lastAssistantText()).toContain("session limit");
}, 60_000);

it("#given a turn the child ran without this connection (an extension's or a resumed session's) #when a chain arrives #then it is refused", async () => {
	// given
	const child = await singleRpcProcess({ retryFallbackCommand: true });
	await child.runtime.session.prompt("go");
	await child.runtime.session.waitForIdle();

	// when
	const late = await child.request({ type: "set_retry_fallback", retryFallback: CHILD_CHAIN });

	// then
	expect(late.success).toBe(false);
	expect(String(late.error)).toContain("before the session's first turn");
}, 60_000);

it("#given an extension added a context message on session start #when the chain arrives before the first turn #then it is applied", async () => {
	// given
	const child = await singleRpcProcess({ retryFallbackCommand: true });
	await child.runtime.session.sendCustomMessage({ customType: "component.usage", content: "context", display: false });

	// when
	const accepted = await child.request({ type: "set_retry_fallback", retryFallback: CHILD_CHAIN });
	await child.request({ type: "prompt", message: "go" });

	// then
	expect(accepted.success).toBe(true);
	expect(child.lastAssistantText()).toBe("answered by spare");
}, 60_000);

it("#given an extension's turn in flight #when a chain arrives #then it is refused", async () => {
	// given
	let release = () => {};
	const firstTurnGate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let held = () => {};
	const turnHeld = new Promise<void>((resolve) => {
		held = resolve;
	});
	const child = await singleRpcProcess({ retryFallbackCommand: true, firstTurnGate, onFirstTurnHeld: () => held() });
	const extensionTurn = child.runtime.session.sendCustomMessage(
		{ customType: "component.wake", content: "wake", display: false },
		{ triggerTurn: true },
	);
	await turnHeld;

	// when
	const midTurn = await child.request({ type: "set_retry_fallback", retryFallback: CHILD_CHAIN });
	release();
	await extensionTurn;
	await child.runtime.session.waitForIdle();

	// then
	expect(midTurn.success).toBe(false);
	expect(String(midTurn.error)).toContain("before the session's first turn");
}, 60_000);

it.each([
	{ label: "steer", command: { type: "steer", message: "go" } },
	{ label: "follow_up", command: { type: "follow_up", message: "go" } },
	{ label: "continue_from_leaf", command: { type: "continue_from_leaf" } },
	{
		label: "send_custom_message with triggerTurn",
		command: { type: "send_custom_message", customType: "client.wake", content: "wake", triggerTurn: true },
	},
])(
	"#given a $label just sent #when a chain arrives right behind it #then it is refused",
	async ({ command }) => {
		// given
		const child = await singleRpcProcess({ retryFallbackCommand: true });
		child.sendWithoutWaiting(command);

		// when
		const behind = await child.request({ type: "set_retry_fallback", retryFallback: CHILD_CHAIN });
		await child.runtime.session.waitForIdle();

		// then
		expect(behind.success).toBe(false);
		expect(String(behind.error)).toContain("before the session's first turn");
	},
	60_000,
);

it("#given a client context message that asks for no turn #when the chain arrives #then it is applied, like an extension's", async () => {
	// given
	const child = await singleRpcProcess({ retryFallbackCommand: true });
	await child.request({
		type: "send_custom_message",
		customType: "client.context",
		content: "context",
		display: false,
	});

	// when
	const accepted = await child.request({ type: "set_retry_fallback", retryFallback: CHILD_CHAIN });
	await child.request({ type: "prompt", message: "go" });

	// then
	expect(accepted.success).toBe(true);
	expect(child.lastAssistantText()).toBe("answered by spare");
}, 60_000);

it("#given a child told its chain #when it moves to a replacement session #then the replacement answers on the chain and the settings file is untouched", async () => {
	// given
	const child = await singleRpcProcess({ retryFallbackCommand: true });
	const settingsBefore = readFileSync(child.settingsPath);
	await child.request({ type: "set_retry_fallback", retryFallback: CHILD_CHAIN });

	// when
	const replaced = await child.runtime.newSession();
	await child.runtime.session.bindExtensions({});
	await child.request({ type: "prompt", message: "go" });

	// then
	expect(replaced.cancelled).toBe(false);
	expect(child.lastAssistantText()).toBe("answered by spare");
	expect(readFileSync(child.settingsPath)).toEqual(settingsBefore);
	expect(child.runtime.session.settingsManager.getRetryFallbackSettings().chains).toMatchObject({
		"faux-fallback/primary": ["faux-fallback/spare"],
	});
}, 60_000);

it("#given a malformed chain #when it is sent #then it is refused with the open_session shape rule and nothing is applied", async () => {
	// given
	const child = await singleRpcProcess({ retryFallbackCommand: true });

	// when
	const bad = await child.request({
		type: "set_retry_fallback",
		retryFallback: { fallbackChains: { "faux-fallback/primary": ["faux-fallback/spare"] } },
	});

	// then
	expect(bad.success).toBe(false);
	expect(String(bad.error)).toContain("retryFallback must be");
	expect(child.runtime.session.settingsManager.getRetryFallbackSettings().chains).not.toHaveProperty(
		"faux-fallback/primary",
	);
}, 60_000);
