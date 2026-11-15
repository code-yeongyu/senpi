// senpi#5726 (S33: KILL-HOOK): the user's machine killed around a forwarded loop-hook call and its reply, on the
// in-process reference transport, through the suite runner's case map.
import { describe, expect, it } from "vitest";
import { findImplementationGaps } from "../../src/conformance/mapping.ts";
import { CONFORMANCE_REGISTRY } from "../../src/conformance/registry.ts";
import { createLoopHookHost, LoopHookRestartedError } from "../../src/execution/loop-hook-host.ts";
import { serveLoopHooks } from "../../src/execution/loop-hook-host-hand.ts";
import { KILL_HOOK_CASES, KILL_HOOK_DECLARATIONS } from "../../src/execution/testing/kill-hook.ts";
import { handAdapters } from "./hand-adapters.ts";
import { transportPair } from "./loop-hook-pair.ts";

/** Every call of these tests belongs to one session. */
const oneSession = () => "session";

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
		sessionOf: oneSession,
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
	serveLoopHooks({ transport: link.hand, lane: "hooks", run, sessionOf: oneSession });
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
			sessionOf: oneSession,
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
});
