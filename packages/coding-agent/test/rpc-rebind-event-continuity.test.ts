/**
 * Event continuity across a session replacement.
 *
 * A replacement swaps the live session and rebinds extensions afterwards. That
 * rebind is deferred by design: awaiting it would deadlock a client whose
 * session_start handler blocks on an extension_ui_request it cannot answer
 * while still awaiting the replacement response. But the deferred bind still
 * mutates the session it owns - the pi-rules builtin appends a `pi-rules.scan`
 * entry from `session_start` - and those durable entries must reach every
 * attached connection. A client that misses them can never reconstruct the
 * session it is bound to: nothing else re-reads the binding, and the file is
 * not written until an assistant message exists, so disk cannot rescue it.
 *
 * Pinned in-process against the real `createRpcConnectionHandler` with a real
 * `AgentSession` from the suite harness, so the bind runs for real and the
 * append lands inside it - no child process, no load, no timing.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createRpcConnectionHandler, type RpcConnectionSink } from "../src/modes/rpc/connection-handler.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

type RpcRecord = Record<string, unknown>;

function makeSink(): {
	sink: RpcConnectionSink;
	waitFor: (p: (r: RpcRecord) => boolean, t?: number) => Promise<RpcRecord>;
} {
	const records: RpcRecord[] = [];
	const waiters: Array<{ predicate: (r: RpcRecord) => boolean; resolve: (r: RpcRecord) => void }> = [];
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
					if (line) {
						try {
							dispatch(JSON.parse(line) as RpcRecord);
						} catch {
							/* partial line */
						}
					}
					newline = buffer.indexOf("\n");
				}
			},
			waitForBackpressure: async () => {},
		},
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
					resolve: (record) => {
						clearTimeout(timer);
						resolve(record);
					},
				};
				waiters.push(waiter);
			});
		},
	};
}

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

describe("RPC rebind event continuity", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.restoreAllMocks();
	});

	async function newHarness(): Promise<Harness> {
		const harness = await createHarness({ models: [{ id: "rebind-continuity-model", reasoning: true }] });
		harnesses.push(harness);
		return harness;
	}

	it("delivers entries appended while extensions are still binding after a replacement", async () => {
		const first = await newHarness();
		const second = await newHarness();
		const collected = makeSink();
		const host = makeRuntimeHost(first.session);

		// Reproduce exactly what the pi-rules builtin does: append a durable entry
		// from the session_start handler, which runs inside the deferred bind. The
		// append happens once the bind has set rpc mode, so the notification is
		// emitted on the wire lane it belongs to.
		const originalBind = second.session.bindExtensions.bind(second.session);
		let resolveDuringBind!: () => void;
		const duringBind = new Promise<void>((resolve) => {
			resolveDuringBind = resolve;
		});
		second.session.bindExtensions = async (options: unknown) => {
			const result = await originalBind(options as never);
			resolveDuringBind();
			second.session.appendSessionEntry({
				type: "custom",
				customType: "pi-rules.scan",
				id: "during-bind-entry",
				parentId: null,
				timestamp: new Date().toISOString(),
				data: { reason: "new" },
			} as never);
			return result;
		};

		const handler = createRpcConnectionHandler(host.runtimeHost, collected.sink, { sessionId: "rpc-attached" });
		await handler.ready;

		// The replacement is driven the way AgentSessionRuntime drives one: swap the
		// live session, then invoke the rebind callback, which acknowledges before
		// the deferred bind finishes.
		await host.replaceWith(second.session);
		// Waiting on the append itself, not on a delay, keeps this deterministic.
		await duringBind;

		// The entry the host durably recorded while binding must reach this
		// connection. There is no later refresh to rescue it: the session file is
		// not written until an assistant message exists, so this notification is the
		// only channel that can ever carry it.
		const record = await collected.waitFor((r) => r.type === "entry_appended");
		expect(record).toMatchObject({
			type: "entry_appended",
			entry: expect.objectContaining({ customType: "pi-rules.scan" }),
		});

		await handler.dispose();
	});
});
