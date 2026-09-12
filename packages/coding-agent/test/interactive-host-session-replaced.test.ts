/**
 * The shared-host proxy must re-read its binding when the host swaps the live
 * session underneath it.
 *
 * A replacement can be driven by any other attached client, or by an extension
 * that no client asked. The command response for one carries only
 * `{ cancelled }`, so `session_replaced` is the only signal this connection
 * gets. Without handling it the proxy keeps serving the previous session's
 * manager, settings and message mirror while the host has already moved on.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createRemoteSessionProxy } from "../src/modes/interactive/interactive-host-runtime.ts";
import type { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): { cwd: string; agentDir: string; sessionDir: string } {
	const root = mkdtempSync(join(tmpdir(), "senpi-replaced-"));
	roots.push(root);
	const cwd = join(root, "cwd");
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	for (const dir of [cwd, agentDir, sessionDir]) mkdirSync(dir, { recursive: true });
	return { cwd, agentDir, sessionDir };
}

function stateFor(manager: SessionManager, cwd: string) {
	return {
		thinkingLevel: "off" as const,
		isStreaming: false,
		isCompacting: false,
		pendingMessageCount: 0,
		usageTotals: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
		} as unknown as ReturnType<SessionManager["getUsageTotals"]>,
		retryAttempt: 0,
		isBashRunning: false,
		sessionFile: manager.getSessionFile(),
		sessionId: manager.getSessionId(),
		sessionName: undefined,
		cwd,
		// The host ships the durable entries alongside the state; refresh() backfills
		// them into a freshly opened manager whose file has not been flushed yet.
		entries: manager.getEntries(),
		projectTrusted: true,
		fastMode: false,
		steeringMode: "enabled" as AgentSession["steeringMode"],
		followUpMode: "all" as AgentSession["followUpMode"],
		autoCompactionEnabled: false,
		favoriteModels: [],
		scopedModels: [],
		steering: [],
		followUp: [],
		ordered: [],
	};
}

describe("shared-host proxy session replacement", () => {
	it("refreshes its binding when the host reports a replacement", async () => {
		const qa = scratch();
		const first = SessionManager.create(qa.cwd, qa.sessionDir);
		first.appendMessage({ role: "user", content: "first-session", timestamp: 1 });
		const second = SessionManager.create(qa.cwd, qa.sessionDir);
		second.appendMessage({ role: "user", content: "second-session", timestamp: 2 });
		expect(second.getSessionFile()).not.toBe(first.getSessionFile());

		let listener: ((event: Record<string, unknown>) => void) | undefined;
		let liveState = stateFor(first, qa.cwd);
		let getStateCalls = 0;
		const client = {
			onEvent(next: (event: Record<string, unknown>) => void) {
				listener = next;
				return () => {};
			},
			async getState() {
				getStateCalls++;
				return liveState;
			},
			async getMessages() {
				return [];
			},
		} as unknown as RpcClient;

		const mirrored: AgentSession["messages"] = [];
		const local = {
			sessionManager: first,
			agent: { state: { messages: mirrored } },
		} as unknown as AgentSession;

		const proxy = createRemoteSessionProxy(local, qa.agentDir, client, stateFor(first, qa.cwd));
		expect(proxy.session.sessionManager.getSessionFile()).toBe(first.getSessionFile());

		// The host has moved to the second session and announces it. This connection
		// never issued the replacement.
		liveState = stateFor(second, qa.cwd);
		listener?.({
			type: "session_replaced",
			durableSessionId: second.getSessionId(),
			sessionFile: second.getSessionFile(),
			cwd: qa.cwd,
		});

		// Refreshes are serialized, so awaiting an explicit one settles the
		// replacement-driven refresh first. No microtask counting, no sleeps.
		await proxy.refresh();

		// Two refreshes ran: the one the event triggered, then this explicit one.
		// Without the event handler only the explicit refresh happens, so this is the
		// assertion that distinguishes handling the event from ignoring it.
		expect(getStateCalls).toBe(2);
		// ...and the binding actually moved: manager, and the mirrored transcript.
		expect(proxy.session.sessionManager.getSessionFile()).toBe(second.getSessionFile());
		expect(mirrored.map((message) => (message.role === "user" ? message.content : undefined))).toEqual([
			"second-session",
		]);
	});

	it("ignores the replacement echo for a replacement this runtime is driving", async () => {
		// A multi-session host broadcasts session_replaced to every connection,
		// including the one that issued the replacement. That connection's own
		// newSession/switchSession/fork already run an ordered refresh/rebind -
		// newSession transports setup entries between two refreshes - so a refresh
		// fired from the echo would race that sequence and read host state before
		// the setup entries land.
		const qa = scratch();
		const only = SessionManager.create(qa.cwd, qa.sessionDir);
		only.appendMessage({ role: "user", content: "only-session", timestamp: 1 });

		let listener: ((event: Record<string, unknown>) => void) | undefined;
		let getStateCalls = 0;
		const client = {
			onEvent(next: (event: Record<string, unknown>) => void) {
				listener = next;
				return () => {};
			},
			async getState() {
				getStateCalls++;
				return stateFor(only, qa.cwd);
			},
			async getMessages() {
				return [];
			},
		} as unknown as RpcClient;

		const local = {
			sessionManager: only,
			agent: { state: { messages: [] as AgentSession["messages"] } },
		} as unknown as AgentSession;

		const proxy = createRemoteSessionProxy(local, qa.agentDir, client, stateFor(only, qa.cwd));

		let echoedInside = false;
		await proxy.aroundLocalReplacement(async () => {
			// The host's echo lands while the runtime owns the sequence.
			listener?.({
				type: "session_replaced",
				durableSessionId: only.getSessionId(),
				sessionFile: only.getSessionFile(),
				cwd: qa.cwd,
			});
			echoedInside = true;
			// The caller owns refresh ordering for its own replacement.
			await proxy.refresh();
		});

		expect(echoedInside).toBe(true);
		// Exactly the caller's own refresh; the echo added none.
		expect(getStateCalls).toBe(1);
	});

	it("keeps serving the bound session when no replacement is announced", async () => {
		const qa = scratch();
		const only = SessionManager.create(qa.cwd, qa.sessionDir);
		only.appendMessage({ role: "user", content: "only-session", timestamp: 1 });

		let listener: ((event: Record<string, unknown>) => void) | undefined;
		let getStateCalls = 0;
		const client = {
			onEvent(next: (event: Record<string, unknown>) => void) {
				listener = next;
				return () => {};
			},
			async getState() {
				getStateCalls++;
				return stateFor(only, qa.cwd);
			},
			async getMessages() {
				return [];
			},
		} as unknown as RpcClient;

		const local = {
			sessionManager: only,
			agent: { state: { messages: [] as AgentSession["messages"] } },
		} as unknown as AgentSession;

		const proxy = createRemoteSessionProxy(local, qa.agentDir, client, stateFor(only, qa.cwd));

		// An unrelated event must not trigger a rebind.
		listener?.({ type: "agent_settled" });
		await proxy.refresh();

		expect(getStateCalls).toBe(1);
		expect(proxy.session.sessionManager.getSessionFile()).toBe(only.getSessionFile());
	});
});
