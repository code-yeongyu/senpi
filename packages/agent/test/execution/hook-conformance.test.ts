// senpi#5726 (S33: KILL-HOOK): the user's machine killed around a forwarded loop-hook call and its reply, on the
// in-process reference transport, through the suite runner's case map.
import { describe, expect, it } from "vitest";
import { findImplementationGaps } from "../../src/conformance/mapping.ts";
import { CONFORMANCE_REGISTRY } from "../../src/conformance/registry.ts";
import { createLoopHookHost, LoopHookRestartedError } from "../../src/execution/loop-hook-host.ts";
import { serveLoopHooks } from "../../src/execution/loop-hook-host-hand.ts";
import { decodeLoopHookMessage } from "../../src/execution/loop-hook-host-protocol.ts";
import { KILL_HOOK_CASES, KILL_HOOK_DECLARATIONS } from "../../src/execution/testing/kill-hook.ts";
import type { FrameHandler, Transport } from "../../src/transport/transport.ts";
import { handAdapters } from "./hand-adapters.ts";

/** Two in-memory transport ends; frames wait until `flush`. `drop` loses the hand's frames of one kind, in its outbox. */
function transportPair(drop: { kind?: string } = {}) {
	const queues: { to: "loop" | "hand"; payload: Uint8Array }[] = [];
	const handlers: { loop?: FrameHandler; hand?: FrameHandler } = {};
	const end = (self: "loop" | "hand", peer: "loop" | "hand"): Transport => ({
		send: async (_lane, payload) => {
			if (self === "hand" && decodeLoopHookMessage(payload)?.kind === drop.kind) return;
			queues.push({ to: peer, payload });
		},
		onFrame: (handler) => {
			handlers[self] = handler;
		},
		inFlight: () => 0,
		close: () => {},
	});
	const flush = async (): Promise<void> => {
		for (let turn = 0; turn < 64; turn++) {
			const next = queues.shift();
			if (next === undefined) await Promise.resolve();
			else await handlers[next.to]?.({ lane: "hooks", payload: next.payload });
		}
	};
	return { loop: end("loop", "hand"), hand: end("hand", "loop"), flush };
}

/** One hook call whose hand process is killed after the hooks ran; then a replacement process starts. */
async function killAfterRunWith(startedLost: boolean) {
	const link = transportPair(startedLost ? { kind: "hook.started" } : {});
	const runs: string[] = [];
	const run = async (event: string) => {
		runs.push(event);
		return { ran: true };
	};
	serveLoopHooks({
		transport: link.hand,
		lane: "hooks",
		run,
		onPoint: (point) => {
			if (point === "ran") throw new Error("hand killed after the hooks ran");
		},
	});
	const host = createLoopHookHost({ transport: link.loop, lane: "hooks" });
	let outcome: unknown;
	host.run("before_agent_start", {}).then(
		(result) => void (outcome = result),
		(error: unknown) => void (outcome = error),
	);
	await link.flush();
	serveLoopHooks({ transport: link.hand, lane: "hooks", run });
	await link.flush();
	return { runs: runs.length, outcome };
}

describe("loop-hook conformance (KILL-HOOK)", () => {
	for (const [id, run] of KILL_HOOK_CASES) {
		it(id, async () => {
			await run(handAdapters("linux"));
		});
	}

	it("registers every KILL-HOOK case with an implementation, killed at each point of the call", () => {
		const registry = CONFORMANCE_REGISTRY.filter(({ id }) => id.startsWith("KILL-HOOK-"));
		expect(findImplementationGaps(registry, KILL_HOOK_CASES)).toEqual({ unimplemented: [], unregistered: [] });
		expect(KILL_HOOK_DECLARATIONS.map(({ at }) => at)).toEqual([
			"received",
			"started",
			"ran",
			"replied",
			"committed",
		]);
	});

	it("at-most-once holds only while the hand's endpoint outlives the hand process", async () => {
		const endpointLived = await killAfterRunWith(false);
		const endpointDiedWithStarted = await killAfterRunWith(true);

		expect(endpointLived.runs).toBe(1);
		expect(endpointLived.outcome).toBeInstanceOf(LoopHookRestartedError);
		expect(endpointDiedWithStarted.runs).toBe(2);
		expect(endpointDiedWithStarted.outcome).toEqual({ ran: true });
	});

	// senpi#5898: a call the loop host stops waiting for is cancelled on the hand, so its hooks see their signal abort.
	it("a call whose caller aborts is cancelled on the hand: the hooks' signal aborts while they run", async () => {
		const link = transportPair();
		const seen: { aborted?: boolean } = {};
		serveLoopHooks({
			transport: link.hand,
			lane: "hooks",
			run: (_event, _payload, signal) =>
				new Promise((resolve) => {
					signal.addEventListener("abort", () => {
						seen.aborted = signal.aborted;
						resolve({ cancelled: true });
					});
				}),
		});
		const host = createLoopHookHost({ transport: link.loop, lane: "hooks" });
		const caller = new AbortController();
		const outcome = host.run("session_before_compact", {}, caller.signal).catch((error: unknown) => error);
		await link.flush();

		caller.abort();
		await link.flush();

		expect(seen.aborted).toBe(true);
		expect(await outcome).toEqual(new Error("Operation aborted"));
	});

	// #6753 review L4: one lane is one session, whose calls the hand runs one at a time, as before cancel existed; the
	// transport still reads the lane meanwhile, so a later call's cancel is not stuck behind a running call.
	it("runs one session's calls one at a time: the next starts only once the previous call's hooks settled", async () => {
		const link = transportPair();
		const started: string[] = [];
		const releaseFirst = Promise.withResolvers<void>();
		serveLoopHooks({
			transport: link.hand,
			lane: "hooks",
			run: async (event) => {
				started.push(event);
				// The first call ignores its signal, as a handler that never looks at it would.
				if (event === "first") await releaseFirst.promise;
				return { event };
			},
		});
		const host = createLoopHookHost({ transport: link.loop, lane: "hooks" });
		const cancelFirst = new AbortController();
		const first = host.run("first", {}, cancelFirst.signal).catch((error: unknown) => error);
		const second = host.run("second", {});
		await link.flush();
		cancelFirst.abort();
		await link.flush();
		const beforeFirstSettled = [...started];

		releaseFirst.resolve();
		await link.flush();

		expect(beforeFirstSettled).toEqual(["first"]);
		expect(started).toEqual(["first", "second"]);
		expect(await first).toEqual(new Error("Operation aborted"));
		expect(await second).toEqual({ event: "second" });
	});

	it("a call cancelled while it waits behind the running one starts with its signal already aborted", async () => {
		const link = transportPair();
		const seen: Record<string, boolean> = {};
		const releaseFirst = Promise.withResolvers<void>();
		serveLoopHooks({
			transport: link.hand,
			lane: "hooks",
			run: async (event, _payload, signal) => {
				seen[event] = signal.aborted;
				if (event === "first") await releaseFirst.promise;
				return { event };
			},
		});
		const host = createLoopHookHost({ transport: link.loop, lane: "hooks" });
		const cancelSecond = new AbortController();
		void host.run("first", {});
		const second = host.run("second", {}, cancelSecond.signal).catch((error: unknown) => error);
		await link.flush();
		cancelSecond.abort();
		await link.flush();

		releaseFirst.resolve();
		await link.flush();

		expect(seen).toEqual({ first: false, second: true });
		expect(await second).toEqual(new Error("Operation aborted"));
	});
});
