// senpi#5898 (#6753 review L4, #6774 review M1, L1, L2): the hand orders loop-hook calls per SESSION, not per lane. One
// session's calls run one at a time; different sessions' calls run side by side, so a stuck call holds no other session.
// A call still waiting its turn ends without running its hooks when it is cancelled or when its wait passes the cap.
import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createLoopHookHost, LoopHookQueueTimeoutError } from "../../src/execution/loop-hook-host.ts";
import { serveLoopHooks } from "../../src/execution/loop-hook-host-hand.ts";
import { transportPair } from "./loop-hook-pair.ts";

const isObject = (value: JsonValue): value is JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const bySession = (_event: string, payload: JsonValue): string | undefined =>
	isObject(payload) && typeof payload.session === "string" ? payload.session : undefined;

/** A hand whose `first` (or `a`) call runs until released, ignoring its signal as a handler that never reads it would. */
function stuckHand(options: { readonly queueWaitMs?: number } = {}) {
	const link = transportPair();
	const started: string[] = [];
	const release = Promise.withResolvers<void>();
	serveLoopHooks({
		transport: link.hand,
		lane: "hooks",
		sessionOf: bySession,
		...(options.queueWaitMs === undefined ? {} : { queueWaitMs: options.queueWaitMs }),
		run: async (event) => {
			started.push(event);
			if (event === "first" || event === "a") await release.promise;
			return { event };
		},
	});
	let next = 0;
	const host = createLoopHookHost({ transport: link.loop, lane: "hooks", mintId: () => `call-${++next}` });
	return { link, host, started, release: () => release.resolve() };
}

describe("loop-hook call order on the hand (senpi#5898)", () => {
	it("runs one session's calls one at a time: the next starts only once the previous call's hooks settled", async () => {
		const { link, host, started, release } = stuckHand();
		const cancelFirst = new AbortController();
		const first = host.run("first", { session: "A" }, cancelFirst.signal).catch((error: unknown) => error);
		const second = host.run("second", { session: "A" });
		await link.flush();
		cancelFirst.abort();
		await link.flush();
		const beforeFirstSettled = [...started];

		release();
		await link.flush();

		expect(beforeFirstSettled).toEqual(["first"]);
		expect(started).toEqual(["first", "second"]);
		expect(await first).toEqual(new Error("Operation aborted"));
		expect(await second).toEqual({ event: "second" });
	});

	it("runs different sessions' calls side by side: a stuck, cancelled call of one session holds no other", async () => {
		const { link, host, started, release } = stuckHand();
		const cancelA = new AbortController();
		const a = host.run("a", { session: "A" }, cancelA.signal).catch((error: unknown) => error);
		await link.flush();
		cancelA.abort();
		const b = host.run("b", { session: "B" });
		await link.flush();

		expect(started).toEqual(["a", "b"]);
		expect(await b).toEqual({ event: "b" });
		release();
		await link.flush();
		expect(await a).toEqual(new Error("Operation aborted"));
	});

	it("a call cancelled while it waits its turn answers hook.failed (cancelled) and never starts its hooks", async () => {
		const { link, host, started, release } = stuckHand();
		void host.run("first", { session: "A" });
		const cancelSecond = new AbortController();
		const second = host.run("second", { session: "A" }, cancelSecond.signal).catch((error: unknown) => error);
		await link.flush();
		cancelSecond.abort();
		await link.flush();
		const answeredBeforeTurn = link.sentByHand.filter(
			(message) => "callId" in message && message.callId === "call-2",
		);

		release();
		await link.flush();

		expect(answeredBeforeTurn).toEqual([
			{ kind: "hook.failed", callId: "call-2", error: expect.any(String), reason: "cancelled" },
		]);
		expect(started).toEqual(["first"]);
		expect(await second).toEqual(new Error("Operation aborted"));
	});

	it("a call that waits its turn past the cap is refused with a typed queue timeout and never starts its hooks", async () => {
		const { link, host, started } = stuckHand({ queueWaitMs: 1_000 });
		void host.run("first", { session: "A" });
		const second = host.run("second", { session: "A" }).catch((error: unknown) => error);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			await link.flush();
			vi.advanceTimersByTime(1_000);
			await link.flush();
		} finally {
			vi.useRealTimers();
		}

		expect(started).toEqual(["first"]);
		expect(await second).toBeInstanceOf(LoopHookQueueTimeoutError);
	});
});
