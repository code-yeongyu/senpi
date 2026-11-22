import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventBus } from "../../../src/core/event-bus.ts";
import {
	createExtensionRuntime,
	drainPendingProviderRegistrations,
	loadExtensionFromFactory,
} from "../../../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../../../src/core/extensions/runner.ts";
import type { ExtensionAPI, ExtensionError } from "../../../src/core/extensions/types.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createRpcConnectionHandler } from "../../../src/modes/rpc/connection-handler.ts";
import { type CollectedSink, type Harness, makeHarness, makeSink } from "../rpc-connection-harness.ts";

// senpi#4436 S1b: an RPC login forwards the progress lines a `provider_login_start` handler reports (for example the
// Claude Code download) as `auth_login_progress` events, instead of dropping them.

const PROVIDER = "anthropic-subscription";
const DOWNLOAD_LINE = "Downloading Claude Code 2.1.306: 10% of 200 MB";

type HostExtension = (pi: ExtensionAPI) => void;

const providerExtension = (logins: string[]) => (pi: ExtensionAPI) => {
	pi.registerProvider(PROVIDER, {
		baseUrl: "http://127.0.0.1:1",
		api: "openai-completions",
		apiKey: "$RPC_LOGIN_PROGRESS_UNUSED",
		models: [
			{
				id: "rpc-login-progress-model",
				name: "rpc-login-progress-model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000,
				maxTokens: 100,
			},
		],
		oauth: {
			name: "RPC login progress provider",
			async login() {
				logins.push("login ran");
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

async function bootRpcHost(harness: Harness, hosts: readonly HostExtension[]) {
	const cwd = process.cwd();
	const runtime = createExtensionRuntime();
	const eventBus = createEventBus();
	const logins: string[] = [];
	const extensions = [
		await loadExtensionFromFactory(providerExtension(logins), cwd, eventBus, runtime, "<inline:provider>"),
	];
	for (const [index, host] of hosts.entries()) {
		extensions.push(await loadExtensionFromFactory(host, cwd, eventBus, runtime, `<inline:host-${index}>`));
	}
	const modelRegistry = harness.runtimeHost.session.modelRegistry;
	for (const registration of drainPendingProviderRegistrations(runtime)) {
		if (registration.kind === "config") {
			await modelRegistry.modelRuntime.registerProvider(registration.name, registration.config, {
				extensionPath: registration.extensionPath,
			});
		}
	}
	const runner = new ExtensionRunner(extensions, runtime, cwd, SessionManager.inMemory(cwd), modelRegistry);
	const errors: ExtensionError[] = [];
	runner.onError((error) => errors.push(error));
	return { logins, errors };
}

async function runRpcLogin(collected: CollectedSink, harness: Harness) {
	const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);
	await handler.handleInputLine(JSON.stringify({ id: "login", type: "login_start", provider: PROVIDER }));
	const end = await collected.waitFor((message) => message.type === "auth_login_end");
	await handler.dispose();
	return end;
}

const progressEvents = (collected: CollectedSink) =>
	collected.messages().filter((message) => message.type === "auth_login_progress");

describe("RPC login progress (senpi#4436)", () => {
	let tempDir: string;
	let cleanup: () => void = () => {};

	beforeEach(() => {
		tempDir = join(tmpdir(), `rpc-login-progress-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		cleanup();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("an RPC login_start emits auth_login_progress for a provider_login_start progress line", async () => {
		const harness = makeHarness(tempDir);
		cleanup = harness.cleanup;
		const { logins } = await bootRpcHost(harness, [
			(pi) => {
				pi.on("provider_login_start", async (event) => {
					event.progress(DOWNLOAD_LINE);
				});
			},
		]);
		const collected = makeSink();

		const end = await runRpcLogin(collected, harness);

		expect(end).toMatchObject({ provider: PROVIDER, success: true });
		expect(progressEvents(collected)).toEqual([
			{ type: "auth_login_progress", provider: PROVIDER, text: DOWNLOAD_LINE },
		]);
		expect(logins).toEqual(["login ran"]);
	});

	it("handlers run in registration order and their progress lines arrive in that order", async () => {
		const harness = makeHarness(tempDir);
		cleanup = harness.cleanup;
		const order: string[] = [];
		await bootRpcHost(harness, [
			(pi) => {
				pi.on("provider_login_start", async (event) => {
					order.push("first");
					event.progress("first handler");
				});
			},
			(pi) => {
				pi.on("provider_login_start", async (event) => {
					order.push("second");
					event.progress("second handler");
				});
			},
		]);
		const collected = makeSink();

		await runRpcLogin(collected, harness);

		expect(order).toEqual(["first", "second"]);
		expect(progressEvents(collected).map((message) => message.text)).toEqual(["first handler", "second handler"]);
	});

	it("a throwing handler is reported and the login still runs", async () => {
		const harness = makeHarness(tempDir);
		cleanup = harness.cleanup;
		const { logins, errors } = await bootRpcHost(harness, [
			(pi) => {
				pi.on("provider_login_start", async () => {
					throw new Error("handler failed");
				});
			},
			(pi) => {
				pi.on("provider_login_start", async (event) => {
					event.progress("after the failure");
				});
			},
		]);
		const collected = makeSink();

		const end = await runRpcLogin(collected, harness);

		expect(end).toMatchObject({ provider: PROVIDER, success: true });
		expect(logins).toEqual(["login ran"]);
		expect(errors).toEqual([
			expect.objectContaining({
				extensionPath: "<inline:host-0>",
				event: "provider_login_start",
				error: "handler failed",
			}),
		]);
		expect(progressEvents(collected).map((message) => message.text)).toEqual(["after the failure"]);
	});
});
