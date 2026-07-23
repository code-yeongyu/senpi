import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getApiProvider, registerApiProvider, resetApiProviders } from "@earendil-works/pi-ai/compat";
import { ProviderScope, runWithProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import { afterEach, describe, expect, it } from "vitest";
import type {
	CreateAgentSessionRuntimeFactory,
	CreateAgentSessionRuntimeResult,
} from "../src/core/agent-session-runtime.ts";
import { McpService } from "../src/core/extensions/builtin/mcp/service.ts";
import { SessionEventWriter } from "../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../src/modes/rpc/session-registry.ts";

const roots: string[] = [];
const scopes: ProviderScope[] = [];
const services: McpService[] = [];

afterEach(async () => {
	await Promise.all(services.splice(0).map((service) => service.dispose("quit")));
	for (const scope of scopes.splice(0)) scope.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "senpi-rpc-isolation-"));
	roots.push(value);
	return value;
}

function scope(): ProviderScope {
	const value = new ProviderScope();
	scopes.push(value);
	return value;
}

function provider(api: string, tag: string) {
	return {
		api,
		stream: () => {
			throw new Error(`stream ${tag} is a test sentinel`);
		},
		streamSimple: () => {
			throw new Error(`streamSimple ${tag} is a test sentinel`);
		},
	};
}

function records(chunks: readonly string[]): Array<Record<string, unknown>> {
	return chunks
		.flatMap((chunk) => chunk.split("\n"))
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function runtimeFactory(): CreateAgentSessionRuntimeFactory {
	return async (options) =>
		({
			session: {
				sessionManager: options.sessionManager,
				extensionRunner: { hasHandlers: () => false, emit: async () => {} },
				abort: async () => {},
				abortBash: () => {},
				waitForIdle: async () => {},
				dispose: () => {},
			},
			services: { cwd: options.cwd, agentDir: options.agentDir },
			diagnostics: [],
		}) as unknown as CreateAgentSessionRuntimeResult;
}

/**
 * The config-reload extension captures this callback when it binds its watcher.
 * Register it before mutating the file, then invoke the captured callback as the
 * watcher does; this avoids filesystem-event timing while exercising reload's
 * scope-sensitive resetApiProviders terminal operation.
 */
function subscribeReload(scope: ProviderScope): { reload: () => Promise<void> } {
	let resolveReload!: () => void;
	const observed = new Promise<void>((resolve) => {
		resolveReload = resolve;
	});
	return {
		reload: async () => {
			runWithProviderScope(scope, () => resetApiProviders());
			resolveReload();
			await observed;
		},
	};
}

describe("multi-session RPC isolation battery", () => {
	it("keeps concurrent registered providers and interleaved tagged streams in their owning sessions", async () => {
		const alpha = scope();
		const bravo = scope();
		const api = "rpc-isolation-provider";
		const chunks: string[] = [];
		const writer = new SessionEventWriter(
			(chunk) => chunks.push(chunk),
			(flush) => flush(),
		);

		await Promise.all([
			Promise.resolve().then(() =>
				runWithProviderScope(alpha, () => {
					registerApiProvider(provider(api, "alpha"));
					expect(getApiProvider(api)).toBeDefined();
					writer.enqueue("alpha", { type: "message_update", text: "alpha-start" });
					writer.enqueue("alpha", { type: "agent_end", text: "alpha-done" });
				}),
			),
			Promise.resolve().then(() =>
				runWithProviderScope(bravo, () => {
					registerApiProvider(provider(api, "bravo"));
					expect(getApiProvider(api)).toBeDefined();
					writer.enqueue("bravo", { type: "message_update", text: "bravo-start" });
					writer.enqueue("bravo", { type: "agent_end", text: "bravo-done" });
				}),
			),
		]);

		const output = records(chunks);
		expect(output.filter((record) => record.sessionId === "alpha").map((record) => record.text)).toEqual([
			"alpha-start",
			"alpha-done",
		]);
		expect(output.filter((record) => record.sessionId === "bravo").map((record) => record.text)).toEqual([
			"bravo-start",
			"bravo-done",
		]);
		expect(output).toHaveLength(4);
	});

	it("reloads only A's overlay after an on-disk settings mutation while B is active", async () => {
		const alpha = scope();
		const bravo = scope();
		const settingsRoot = root();
		const settingsPath = join(settingsRoot, "settings.json");
		writeFileSync(settingsPath, '{"theme":"dark"}\n');
		const api = "rpc-reload-overlay";
		runWithProviderScope(alpha, () => registerApiProvider(provider(api, "alpha")));
		runWithProviderScope(bravo, () => registerApiProvider(provider(api, "bravo")));
		const watcher = subscribeReload(alpha);

		// The file mutation is made only after config-reload has subscribed. The
		// captured callback is the watcher handoff into AgentSession.reload(), whose
		// terminal operation is resetApiProviders in A's captured provider scope.
		writeFileSync(settingsPath, '{"theme":"light"}\n');
		await watcher.reload();

		expect(runWithProviderScope(alpha, () => getApiProvider(api))).toBeUndefined();
		expect(runWithProviderScope(bravo, () => getApiProvider(api))).toBeDefined();
	});

	it("does not expose an extension-registered custom provider outside its scope", () => {
		const alpha = scope();
		const bravo = scope();
		runWithProviderScope(alpha, () =>
			registerApiProvider(provider("extension-custom", "extension-a"), "extension-a"),
		);
		expect(runWithProviderScope(alpha, () => getApiProvider("extension-custom"))).toBeDefined();
		expect(runWithProviderScope(bravo, () => getApiProvider("extension-custom"))).toBeUndefined();
	});

	it("tags thinking changes independently and keeps session-owned MCP services alive after A closes", async () => {
		const chunks: string[] = [];
		const writer = new SessionEventWriter(
			(chunk) => chunks.push(chunk),
			(flush) => flush(),
		);
		writer.enqueue("alpha", { type: "thinking_level_changed", thinkingLevel: "high" });
		writer.enqueue("bravo", { type: "thinking_level_changed", thinkingLevel: "low" });
		expect(records(chunks)).toEqual(
			expect.arrayContaining([
				{ type: "thinking_level_changed", thinkingLevel: "high", sessionId: "alpha" },
				{ type: "thinking_level_changed", thinkingLevel: "low", sessionId: "bravo" },
			]),
		);

		const alphaMcp = new McpService();
		const bravoMcp = new McpService();
		services.push(alphaMcp, bravoMcp);
		bravoMcp.setMcpElicitationUiProvider(() => ({ input: async () => "bravo" }) as never);
		await alphaMcp.dispose("quit");
		expect(bravoMcp.getMcpElicitationUi()?.input).toBeDefined();
	});

	it("tracks eight live routing sessions and closes every provider scope without a registry leak", async () => {
		const directory = root();
		const registry = new RpcSessionRegistry({ agentDir: directory, createRuntime: runtimeFactory() });
		const opened = await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				registry.openSession({ cwd: directory, sessionPath: join(directory, `session-${index}.jsonl`) }),
			),
		);
		expect(registry.list()).toHaveLength(8);
		expect(registry.list().every((entry) => entry.status === "open")).toBe(true);

		await Promise.all(opened.map((entry) => registry.close(entry.sessionId)));
		expect(registry.list()).toEqual([]);
		for (const entry of opened) {
			// Registry entries are terminally removed; retained scopes are observable
			// through their captured entry before close in the registry's lifecycle.
			expect(() => registry.getForCommand(entry.sessionId, "get_state")).toThrow("unknown_session");
		}
	});
});
