import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { SdkQueryHandle } from "../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { forgetBinding, getBinding } from "../src/core/extensions/builtin/anthropic-subscription/session-reattach.ts";
import {
	AnthropicSubscriptionSessionRegistry,
	closeSession,
	getOrCreateSession,
	getSession,
	overrideSessionRegistryBoundary,
	resetSessionRegistryBoundary,
	SESSION_REGISTRY_IDLE_TTL_MS,
} from "../src/core/extensions/builtin/anthropic-subscription/session-registry.ts";
import { transitionSessionState } from "../src/core/extensions/builtin/anthropic-subscription/session-registry-state.ts";
import { registerSessionRegistry } from "../src/core/extensions/builtin/anthropic-subscription/session-registry-wiring.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Reap = { callback: () => void; delayMs: number; canceled: boolean };

const MAX_IDLE_ENV = "SENPI_CLAUDE_SDK_OAUTH_MAX_IDLE_SESSIONS";
const usedIds = new Set<string>();
let clock = 0;
let open = 0;
let reaps: Reap[] = [];

function fakeQuery(): SdkQueryHandle {
	open++;
	let closed = false;
	return {
		async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {},
		async interrupt() {},
		close() {
			if (!closed) open--;
			closed = true;
		},
	};
}

function useFakeBoundary(extra: Parameters<typeof overrideSessionRegistryBoundary>[0] = {}): void {
	overrideSessionRegistryBoundary({
		now: () => clock,
		queryFactory: () => fakeQuery(),
		scheduleReap: (callback, delayMs) => {
			const reap = { callback, delayMs, canceled: false };
			reaps.push(reap);
			return { cancel: () => (reap.canceled = true), unref: () => {} };
		},
		...extra,
	});
}

function runDueReaps(): void {
	for (const reap of reaps.splice(0)) if (!reap.canceled && reap.delayMs <= 0) reap.callback();
}

function input(senpiSessionId: string) {
	usedIds.add(senpiSessionId);
	return {
		senpiSessionId,
		accountName: "default",
		modelId: "claude-test",
		toolsetHash: "tools-v1",
		systemPromptHash: "prompt-v1",
		options: {},
	};
}

function idleEntry(senpiSessionId: string, registry?: AnthropicSubscriptionSessionRegistry) {
	const entry = registry ? registry.getOrCreate(input(senpiSessionId)) : getOrCreateSession(input(senpiSessionId));
	transitionSessionState(entry, "IDLE_SYNCED");
	return entry;
}

function wiring(): Map<string, Handler[]> {
	const handlers = new Map<string, Handler[]>();
	const api = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	registerSessionRegistry(api);
	return handlers;
}

function ctx(sessionId: string, child: boolean): ExtensionContext {
	const spawnedBy = child
		? { parentSessionId: "parent", rootSessionId: "parent", taskId: `task-${sessionId}` }
		: undefined;
	return {
		sessionManager: {
			getSessionId: () => sessionId,
			getHeader: () => ({ type: "session", id: sessionId, timestamp: "", cwd: "", spawnedBy }),
		},
	} as unknown as ExtensionContext;
}

async function settle(handlers: Map<string, Handler[]>, sessionId: string, child: boolean): Promise<void> {
	for (const handler of handlers.get("agent_settled") ?? [])
		await handler({ type: "agent_settled" }, ctx(sessionId, child));
}

afterEach(() => {
	for (const id of usedIds) {
		closeSession(id, "test_cleanup");
		forgetBinding(id);
	}
	usedIds.clear();
	resetSessionRegistryBoundary();
	delete process.env[MAX_IDLE_ENV];
	clock = 0;
	open = 0;
	reaps = [];
});

describe("anthropic-subscription resident processes of finished child sessions (#5689)", () => {
	it("releases every finished child's resident process when its run settles, keeping its binding", async () => {
		useFakeBoundary({ maxIdleEntries: () => 32 });
		const handlers = wiring();
		const children = Array.from({ length: 5 }, (_, index) => `child-${index}`);
		for (const id of children) idleEntry(id);
		expect(open).toBe(5);

		for (const id of children) await settle(handlers, id, true);

		expect(open).toBe(0);
		for (const id of children) {
			expect(getSession(id)).toBeUndefined();
			expect(getBinding(id)).toBeDefined();
		}
	});

	it("releases a child whose turn is still in flight once that turn goes idle", async () => {
		useFakeBoundary({ maxIdleEntries: () => 32 });
		const handlers = wiring();
		const entry = idleEntry("child-busy");
		entry.activeTurn = { generation: entry.generation };

		await settle(handlers, "child-busy", true);
		expect(getSession("child-busy")).toBe(entry);

		entry.activeTurn = null;
		runDueReaps();
		expect(getSession("child-busy")).toBeUndefined();
		expect(open).toBe(0);
	});

	it("keeps a settled main session resident through a short idle within the TTL", async () => {
		useFakeBoundary();
		const handlers = wiring();
		const entry = idleEntry("main-session");

		await settle(handlers, "main-session", false);
		clock += 5 * 60_000;

		expect(getOrCreateSession(input("main-session"))).toBe(entry);
		expect(open).toBe(1);
		expect(clock).toBeLessThan(SESSION_REGISTRY_IDLE_TTL_MS);
	});
});

describe("anthropic-subscription idle resident cap (#5689)", () => {
	it("evicts the least-recently-used idle entry at admission and never an in-use one", () => {
		useFakeBoundary({ maxIdleEntries: () => 2 });
		const registry = new AnthropicSubscriptionSessionRegistry();
		const busy = registry.getOrCreate(input("busy"));
		transitionSessionState(busy, "IDLE_SYNCED");
		transitionSessionState(busy, "TURN_WAITING");
		for (const id of ["idle-a", "idle-b", "idle-c"]) {
			clock++;
			idleEntry(id, registry);
		}

		clock++;
		registry.getOrCreate(input("fresh"));

		expect(registry.get("busy")).toBe(busy);
		expect(registry.get("idle-a")).toBeUndefined();
		expect(registry.get("idle-b")?.state).toBe("IDLE_SYNCED");
		expect(registry.get("idle-c")?.state).toBe("IDLE_SYNCED");
		expect(registry.get("fresh")?.state).toBe("STARTING");
	});

	it("trims idle entries when a turn settles, with no new admission", () => {
		useFakeBoundary({ maxIdleEntries: () => 2 });
		const registry = new AnthropicSubscriptionSessionRegistry();
		const entries = ["turn-a", "turn-b", "turn-c"].map((id) => {
			clock++;
			const entry = idleEntry(id, registry);
			entry.activeTurn = { generation: entry.generation };
			return entry;
		});

		for (const entry of entries) {
			clock++;
			entry.activeTurn = null;
		}

		expect(registry.get("turn-a")).toBeUndefined();
		expect(registry.get("turn-b")).toBe(entries[1]);
		expect(registry.get("turn-c")).toBe(entries[2]);
	});

	it("reads the cap from SENPI_CLAUDE_SDK_OAUTH_MAX_IDLE_SESSIONS and ignores invalid values", () => {
		useFakeBoundary();
		const registry = new AnthropicSubscriptionSessionRegistry();
		process.env[MAX_IDLE_ENV] = "1";
		idleEntry("env-a", registry);
		clock++;
		idleEntry("env-b", registry);
		clock++;
		registry.getOrCreate(input("env-c"));
		expect(registry.get("env-a")).toBeUndefined();
		expect(registry.get("env-b")).toBeDefined();

		process.env[MAX_IDLE_ENV] = "0";
		for (let index = 0; index < 8; index++) {
			clock++;
			idleEntry(`env-default-${index}`, registry);
		}
		registry.getOrCreate(input("env-last"));
		expect(registry.get("env-b")).toBeUndefined();
		expect(registry.get("env-default-0")).toBeDefined();
	});
});
