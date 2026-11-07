import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type {
	CreateAgentSessionRuntimeFactory,
	CreateAgentSessionRuntimeResult,
} from "../src/core/agent-session-runtime.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { SessionCommandRouter } from "../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../src/modes/rpc/session-registry.ts";
import { fakeSessionBase } from "./helpers/fake-session-base.ts";

// senpi#3376 review: the successor's reopen replays the park record faithfully. A field the record
// left empty stays empty; the successor's own defaults must not fill it.

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function runtime(options: Parameters<CreateAgentSessionRuntimeFactory>[0]): CreateAgentSessionRuntimeResult {
	new ProjectTrustStore(options.agentDir).set(options.cwd, true);
	return {
		session: {
			...fakeSessionBase(options),
			isFastModeActive: () => false,
			agent: { state: {} },
			isStreaming: false,
			// The shared state builder projects open_session through the full session
			getContextUsage: () => undefined,
			favoriteModels: [],
			scopedModels: [],
			isBashRunning: false,
			extensionRunner: { hasHandlers: () => false, emit: async () => {} },
			abort: async () => {},
			waitForIdle: async () => {},
			dispose: () => {},
			messages: [],
			pendingMessageCount: 0,
		},
		services: { cwd: options.cwd, agentDir: options.agentDir },
		diagnostics: [],
	} as unknown as CreateAgentSessionRuntimeResult;
}

async function routerWithDefaults() {
	const dir = await mkdtemp(join(tmpdir(), "senpi-reopen-defaults-"));
	directories.push(dir);
	const registry = new RpcSessionRegistry({ agentDir: dir, createRuntime: async (options) => runtime(options) });
	const router = new SessionCommandRouter(
		registry,
		new SessionEventWriter(() => {}),
		{ cwd: dir, permissionPreset: "full-access", initialThinkingLevel: "high" },
		async () => ({ handle: async () => {}, dispose: async () => {} }),
	);
	return { dir, registry, router };
}

describe("a parked session's reopen does not take the successor's defaults", () => {
	test("a field the park left empty stays empty", async () => {
		const { dir, registry, router } = await routerWithDefaults();
		expect(
			await router.reopenParked({ sessionPath: join(dir, "parked.jsonl"), retainOnDisconnect: true, cwd: dir }),
		).toBeUndefined();
		const [row] = registry.list();
		const profile = registry.peek(row!.sessionId)?.profile;
		expect(profile?.permissionPreset).toBeUndefined();
		expect(profile?.initialThinkingLevel).toBeUndefined();
	});

	test("a field the park recorded is replayed as recorded", async () => {
		const { dir, registry, router } = await routerWithDefaults();
		await router.reopenParked({
			sessionPath: join(dir, "parked-ask.jsonl"),
			retainOnDisconnect: true,
			cwd: dir,
			permissionPreset: "ask",
			thinkingLevel: "low",
		});
		const [row] = registry.list();
		const profile = registry.peek(row!.sessionId)?.profile;
		expect(profile?.permissionPreset).toBe("ask");
		expect(profile?.initialThinkingLevel).toBe("low");
	});

	// senpi#3853: the mutable context patch survives without replacing the frozen extension context.
	test("restores a nonterminal context overlay before publishing the reopened session", async () => {
		const { dir, registry, router } = await routerWithDefaults();
		try {
			await router.reopenParked({
				sessionPath: join(dir, "parked-context.jsonl"),
				retainOnDisconnect: true,
				sessionContext: { task_status: "queued", stale: "remove" },
				contextOverlay: { task_status: "running", progress: 3, stale: null },
			});
			const [row] = registry.list();
			if (!row) throw new Error("session was not reopened");
			expect(registry.peek(row.sessionId)?.context).toMatchObject({ task_status: "queued", stale: "remove" });
			expect(row.context).toEqual({ task_status: "running", progress: 3 });
		} finally {
			await router.dispose();
		}
	});
});
