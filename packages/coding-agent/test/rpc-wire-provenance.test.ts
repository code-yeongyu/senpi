/**
 * Wire-contract provenance pins for the connection-router audit (findings 1, 4, 8).
 *
 * All three findings are the same shape: a field or an event that MUST cross the RPC
 * boundary was never added to the wire contract, so an attached client cannot
 * reconstruct authoritative host state. Each is pinned in-process against the real
 * `createRpcConnectionHandler` with a real `AgentSession` from the suite harness — no
 * child process is spawned, so these tests do not contend with the host-spawning suites.
 *
 *  1. Session replacement is not broadcast to other attached clients.
 *  4. User abort provenance is lost across the RPC boundary.
 *  8. Thinking-selection provenance is absent from state and change events.
 */

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createRpcConnectionHandler, type RpcConnectionSink } from "../src/modes/rpc/connection-handler.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

type RpcRecord = Record<string, unknown>;

interface CollectedSink {
	sink: RpcConnectionSink;
	messages: () => readonly RpcRecord[];
	waitFor: (predicate: (message: RpcRecord) => boolean, timeoutMs?: number) => Promise<RpcRecord>;
}

function makeSink(): CollectedSink {
	const records: RpcRecord[] = [];
	const waiters: Array<{ predicate: (message: RpcRecord) => boolean; resolve: (message: RpcRecord) => void }> = [];
	let buffer = "";

	const dispatch = (record: RpcRecord) => {
		records.push(record);
		for (const waiter of [...waiters]) {
			if (!waiter.predicate(record)) continue;
			waiters.splice(waiters.indexOf(waiter), 1);
			waiter.resolve(record);
		}
	};

	return {
		sink: {
			writeRaw(chunk) {
				buffer += chunk;
				let newline = buffer.indexOf("\n");
				while (newline !== -1) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (line) dispatch(JSON.parse(line) as RpcRecord);
					newline = buffer.indexOf("\n");
				}
			},
			waitForBackpressure: async () => {},
		},
		messages: () => records,
		waitFor(predicate, timeoutMs = 5_000) {
			const existing = records.find(predicate);
			if (existing) return Promise.resolve(existing);
			return new Promise((resolve, reject) => {
				let waiter!: (typeof waiters)[number];
				const timer = setTimeout(() => {
					const index = waiters.indexOf(waiter);
					if (index !== -1) waiters.splice(index, 1);
					reject(new Error("Timed out waiting for the expected RPC record"));
				}, timeoutMs);
				waiter = {
					predicate,
					resolve: (message) => {
						clearTimeout(timer);
						resolve(message);
					},
				};
				waiters.push(waiter);
			});
		},
	};
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

/**
 * A runtime host whose `session` getter is swappable and whose `setRebindSession`
 * callback is captured, so a replacement can be driven exactly the way
 * `AgentSessionRuntime` drives one: swap the live session, then invoke the callback.
 */
function makeRuntimeHost(initial: AgentSession): {
	runtimeHost: AgentSessionRuntime;
	replaceWith: (next: AgentSession) => Promise<void>;
} {
	let live = initial;
	let rebind: (() => Promise<void>) | undefined;
	const runtimeHost = {
		get session() {
			return live;
		},
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn((callback?: () => Promise<void>) => {
			rebind = callback;
		}),
	} as unknown as AgentSessionRuntime;

	return {
		runtimeHost,
		replaceWith: async (next) => {
			live = next;
			await rebind?.();
		},
	};
}

describe("RPC wire provenance", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.restoreAllMocks();
	});

	async function newHarness(): Promise<Harness> {
		const harness = await createHarness({ models: [{ id: "provenance-model", reasoning: true }] });
		harnesses.push(harness);
		return harness;
	}

	// Finding 1 -----------------------------------------------------------------
	it("broadcasts the replacement identity to an attached client after a runtime session swap", async () => {
		const first = await newHarness();
		const second = await newHarness();
		const collected = makeSink();
		const host = makeRuntimeHost(first.session);
		const handler = createRpcConnectionHandler(host.runtimeHost, collected.sink);
		await handler.ready;

		const replaced = collected.waitFor((record) => record.type === "session_replaced");
		await host.replaceWith(second.session);

		// An attached client that did not issue the replacement must be told the live
		// binding moved, and must be given the new authoritative identity so it can
		// resync without guessing. Without this it keeps routing at the old session.
		expect(await replaced).toMatchObject({
			type: "session_replaced",
			sessionId: second.session.sessionId,
			cwd: second.session.sessionManager.getCwd(),
		});
		expect(second.session.sessionId).not.toBe(first.session.sessionId);

		await handler.dispose();
	});

	// Finding 4 -----------------------------------------------------------------
	it("carries user abort provenance across the RPC boundary in state and the abort event", async () => {
		const harness = await newHarness();
		const collected = makeSink();
		const host = makeRuntimeHost(harness.session);
		const handler = createRpcConnectionHandler(host.runtimeHost, collected.sink);
		await handler.ready;

		// Drive a real user abort through the RPC `abort` command so the provenance is
		// produced by the same path a client uses, not by poking session internals.
		// The turn is held open by waiting for the first assistant delta rather than by
		// sleeping, so the abort always lands mid-stream.
		const streamStarted = deferred();
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "message_update" && event.message.role === "assistant") streamStarted.resolve();
		});
		harness.setResponses([fauxAssistantMessage("streaming response ".repeat(4_000))]);
		const streaming = harness.session.prompt("hold");
		await streamStarted.promise;

		const aborted = collected.waitFor((record) => record.type === "agent_end");
		await handler.handleInputLine(JSON.stringify({ id: "abort-1", type: "abort" }));
		await streaming.catch(() => {});
		unsubscribe();

		// The `agent_end` the RPC connection forwards comes from `session.subscribe`,
		// which delivers only `{ type, messages, willRetry }` — the abort provenance the
		// extension hook sees is stripped from it. A client therefore cannot tell a
		// user-owned abort from a provider one on the wire.
		expect(await aborted).toMatchObject({ aborted: true, abortSource: "user" });

		// The abort owner ("user") must ALSO be reconstructible from the authoritative
		// state snapshot, which is what an attached client mirrors host state from. The
		// live `session.currentAbortSource` getter is transient — it is cleared once the
		// turn settles — so a snapshot taken after settle must report the LAST turn's
		// owner, not `undefined`. The renderer selects the "Operation aborted" wording
		// from exactly this provenance.
		await handler.handleInputLine(JSON.stringify({ id: "state-4", type: "get_state" }));
		const stateResponse = await collected.waitFor((record) => record.id === "state-4");
		expect((stateResponse.data as Record<string, unknown>).lastAbortSource).toBe("user");

		await handler.dispose();
	});

	// Finding 8 -----------------------------------------------------------------
	it("publishes thinking-selection provenance in session state and the thinking change event", async () => {
		const harness = await newHarness();
		const collected = makeSink();
		const host = makeRuntimeHost(harness.session);
		const handler = createRpcConnectionHandler(host.runtimeHost, collected.sink);
		await handler.ready;

		const levels = harness.session.getAvailableThinkingLevels();
		const target = levels.find((level) => level !== harness.session.thinkingLevel);
		// Guard the fixture: a single-level model would make this vacuous.
		expect(target).toBeDefined();

		const changed = collected.waitFor((record) => record.type === "thinking_level_changed");
		await handler.handleInputLine(
			JSON.stringify({ id: "think-1", type: "set_thinking_level", level: target, scope: "session" }),
		);

		// An explicit client selection must be distinguishable on the wire from an
		// SDK-defaulted effective level; only `thinkingSelection` carries that.
		expect(await changed).toMatchObject({
			type: "thinking_level_changed",
			level: target,
			thinkingSelection: { level: target, source: "explicit" },
		});

		await handler.handleInputLine(JSON.stringify({ id: "state-8", type: "get_state" }));
		const stateResponse = await collected.waitFor((record) => record.id === "state-8");
		expect((stateResponse.data as Record<string, unknown>).thinkingSelection).toEqual({
			level: target,
			source: "explicit",
		});

		await handler.dispose();
	});
});
