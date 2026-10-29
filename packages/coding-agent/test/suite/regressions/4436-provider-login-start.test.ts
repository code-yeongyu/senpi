import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { createEventBus } from "../../../src/core/event-bus.ts";
import { resolveClaudeCodeExecutable } from "../../../src/core/extensions/builtin/anthropic-subscription/executable.ts";
import {
	createExtensionRuntime,
	drainPendingProviderRegistrations,
	loadExtensionFromFactory,
} from "../../../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../../../src/core/extensions/runner.ts";
import type { ExtensionAPI, ProviderLoginStartEvent } from "../../../src/core/extensions/types.ts";
import { ModelRegistry } from "../../../src/core/model-registry.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";

// senpi#4436 S1: a provider login fires the awaited `provider_login_start` event before the login runs, so a
// host extension can acquire the Claude Code binary first and set it; the login then resolves that binary.

const PROVIDER = "login-start-provider";
const PINNED_BINARY = "/opt/pinned/claude";

type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => {
	let resolve = () => {};
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
};

/** Synthetic environment: no override, no PATH, no bundled package, until the host handler sets the binary. */
function createHarness() {
	const env = new Map<string, string>();
	const handlerEntered = deferred();
	const releaseHandler = deferred();
	const events: ProviderLoginStartEvent[] = [];
	const resolvedExecutables: string[] = [];

	const providerExtension = (pi: ExtensionAPI) => {
		pi.registerProvider(PROVIDER, {
			baseUrl: "http://127.0.0.1:1",
			api: "openai-completions",
			apiKey: "$PROVIDER_LOGIN_START_UNUSED",
			models: [
				{
					id: "login-start-model",
					name: "login-start-model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1000,
					maxTokens: 100,
				},
			],
			oauth: {
				name: "Login start provider",
				async login() {
					resolvedExecutables.push(
						resolveClaudeCodeExecutable({
							platform: "linux",
							arch: "x64",
							env: (name) => env.get(name),
							resolve: (spec) => {
								throw new Error(`not installed: ${spec}`);
							},
							isFile: (path) => path === PINNED_BINARY,
						}),
					);
					return { access: "a", refresh: "r", expires: Date.now() + 60_000 };
				},
				async refreshToken(credentials) {
					return credentials;
				},
				getApiKey(credentials) {
					return credentials.access;
				},
			},
		});
	};

	const hostExtension = (pi: ExtensionAPI) => {
		pi.on("provider_login_start", async (event) => {
			events.push(event);
			if (event.provider !== PROVIDER) return;
			handlerEntered.resolve();
			await releaseHandler.promise;
			env.set("CLAUDE_CODE_EXECUTABLE", PINNED_BINARY);
		});
	};

	return { env, handlerEntered, releaseHandler, events, resolvedExecutables, providerExtension, hostExtension };
}

async function bootHost(harness: ReturnType<typeof createHarness>) {
	const cwd = process.cwd();
	const runtime = createExtensionRuntime();
	const eventBus = createEventBus();
	const extensions = [
		await loadExtensionFromFactory(harness.providerExtension, cwd, eventBus, runtime, "<inline:provider>"),
		await loadExtensionFromFactory(harness.hostExtension, cwd, eventBus, runtime, "<inline:host>"),
	];
	const storage = AuthStorage.inMemory();
	const modelRuntime = await ModelRuntime.create({ credentials: storage, modelsPath: null, allowModelNetwork: false });
	for (const registration of drainPendingProviderRegistrations(runtime)) {
		if (registration.kind === "config") {
			await modelRuntime.registerProvider(registration.name, registration.config, {
				extensionPath: registration.extensionPath,
			});
		}
	}
	new ExtensionRunner(
		extensions,
		runtime,
		cwd,
		SessionManager.inMemory(cwd),
		new ModelRegistry(modelRuntime, storage),
	);
	return { storage, modelRuntime };
}

async function expectHandlerFirst(harness: ReturnType<typeof createHarness>, login: Promise<unknown>) {
	const first = await Promise.race([
		harness.handlerEntered.promise.then(() => "handler entered"),
		login.then(
			() => "login resolved",
			(error: unknown) => `login failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
		),
	]);
	expect(first).toBe("handler entered");
}

async function expectLoginWaitsForHandler(harness: ReturnType<typeof createHarness>, login: Promise<unknown>) {
	await expectHandlerFirst(harness, login);
	expect(harness.resolvedExecutables).toEqual([]);
	harness.releaseHandler.resolve();
	await login;
	expect(harness.resolvedExecutables).toEqual([PINNED_BINARY]);
	expect(harness.events.map((event) => event.provider)).toEqual([PROVIDER]);
	expect(harness.events[0]?.type).toBe("provider_login_start");
}

describe("provider_login_start (senpi#4436)", () => {
	it("an RPC login waits for the handler and resolves the executable it set", async () => {
		const harness = createHarness();
		const { storage } = await bootHost(harness);
		const login = storage.login(PROVIDER, {
			onAuth: () => {},
			onDeviceCode: () => {},
			onPrompt: async () => "",
			onSelect: async () => undefined,
		});
		await expectLoginWaitsForHandler(harness, login);
	});

	it("a runtime login (TUI and account commands) waits for the handler and resolves the executable it set", async () => {
		const harness = createHarness();
		const { modelRuntime } = await bootHost(harness);
		const login = modelRuntime.login(PROVIDER, "oauth", {
			signal: new AbortController().signal,
			prompt: async () => "",
			notify: () => {},
		});
		await expectLoginWaitsForHandler(harness, login);
	});

	it("hands the handler the login's abort signal and progress line", async () => {
		const harness = createHarness();
		const { modelRuntime } = await bootHost(harness);
		const controller = new AbortController();
		const progress: string[] = [];
		const login = modelRuntime.login(PROVIDER, "oauth", {
			signal: controller.signal,
			prompt: async () => "",
			notify: (event) => {
				if (event.type === "progress") progress.push(event.message);
			},
		});
		await expectHandlerFirst(harness, login);
		const event = harness.events[0];
		event?.progress("Downloading Claude Code");
		expect(progress).toEqual(["Downloading Claude Code"]);
		expect(event?.signal.aborted).toBe(false);
		controller.abort();
		expect(event?.signal.aborted).toBe(true);
		harness.releaseHandler.resolve();
		await login.catch(() => undefined);
	});
});
