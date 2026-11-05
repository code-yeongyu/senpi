import type { JsonValue } from "@earendil-works/pi-ai";
import type { CaseImplementation } from "../../conformance/runner.ts";
import { createManualTimers } from "../../durable/testing/manual-timers.ts";
import { expectEqual } from "../../durable/testing/store-harness.ts";
import { createInProcessNetwork } from "../../transport/in-process-carrier.ts";
import { localEndpoint } from "../../transport/local-endpoint.ts";
import type { TransportCaseAdapters } from "../../transport/testing/transport-harness.ts";
import { createLoopHookHost, LoopHookRestartedError } from "../loop-hook-host.ts";
import { type LoopHookHand, type LoopHookPoint, serveLoopHooks } from "../loop-hook-host-hand.ts";

/**
 * KILL-HOOK (brain/hand split S33): the user's machine is killed around one forwarded hook call and its reply, then a new
 * process starts on the same link. Each case declares what the loop host's turn sees: the hook result (and exactly one
 * provider request carrying it), or a restarted call that is never run again and issues no provider request. These
 * placements only exist where the hook host is engaged (a hosted loop, or any loop away from the user's machine); a
 * fused or split-local session never forwards its hooks.
 */
const LANE = "loop-hooks:session";
const TICK_MS = 5;

/** Where the kill lands: a point of the call on the hand, or after the loop host committed the reply. */
type KillAt = LoopHookPoint | "committed";

interface KillHookCase {
	readonly at: KillAt;
	readonly outcome: "result" | "restarted";
	readonly runs: number;
}

const KILLS: readonly KillHookCase[] = [
	{ at: "received", outcome: "result", runs: 1 },
	{ at: "started", outcome: "restarted", runs: 0 },
	{ at: "ran", outcome: "restarted", runs: 1 },
	{ at: "replied", outcome: "result", runs: 1 },
	{ at: "committed", outcome: "result", runs: 1 },
];

const WHERE: Readonly<Record<KillAt, string>> = {
	received: "after the hand received the hook call, before it started it",
	started: "after the hand said it started the hooks, before they ran",
	ran: "after the hooks ran, before the hand sent the reply",
	replied: "after the hand sent the reply, before the loop host committed it",
	committed: "after the loop host committed the reply, before the provider request",
};

export interface KillHookDeclaration {
	readonly id: string;
	readonly at: KillAt;
	readonly expected: string;
}

const expectedOf = ({ at, outcome, runs }: KillHookCase): string => {
	const result =
		outcome === "result"
			? "the turn gets the hook result and issues exactly one provider request with it"
			: "the call ends restarted (uncertain), is never sent again, and no provider request is issued";
	return `cross-machine and hosted: kill ${WHERE[at]}; ${result}; the hooks ran ${runs === 0 ? "never" : "once"}`;
};

const drain = async (): Promise<void> => {
	for (let turn = 0; turn < 32; turn++) await Promise.resolve();
};

async function runKillCase(adapters: TransportCaseAdapters, kill: KillHookCase, what: string): Promise<void> {
	const timers = createManualTimers(1_000);
	const network = createInProcessNetwork({ schedule: (deliver) => void timers.setTimer(deliver, 0) });
	const loopSide = adapters.transport.createSide(timers);
	const handSide = adapters.transport.createSide(timers);
	const endpoint = localEndpoint(adapters.platform, "loop-hook-conformance", "/run/senpi-conformance");
	network.listen(endpoint, handSide);
	network.dial(endpoint, loopSide).connect();

	const runs: string[] = [];
	const requests: JsonValue[] = [];
	const killed = Promise.withResolvers<void>();
	const startHand = (killAt?: LoopHookPoint): LoopHookHand =>
		serveLoopHooks({
			transport: handSide,
			lane: LANE,
			run: async (event, payload) => {
				runs.push(event);
				return { context: `hook saw ${JSON.stringify(payload)}` };
			},
			onPoint: (point) => {
				if (point !== killAt) return;
				killed.resolve();
				throw new Error(`hand killed ${point}`);
			},
		});
	const until = async (done: () => boolean, label: string): Promise<void> => {
		const end = timers.now() + 600_000;
		await drain();
		while (!done() && timers.now() < end) {
			await timers.advanceTo(timers.now() + TICK_MS);
			await drain();
		}
		if (!done()) throw new Error(`${what}: ${label} not reached`);
	};

	let hand = startHand(kill.at === "committed" ? undefined : kill.at);
	const host = createLoopHookHost({ transport: loopSide, lane: LANE });
	let outcome: { result: JsonValue } | { error: unknown } | undefined;
	host.run("before_agent_start", { prompt: "go" }).then(
		async (result) => {
			if (kill.at === "committed") {
				hand.close();
				killed.resolve();
				hand = startHand();
			}
			requests.push(result);
			outcome = { result };
		},
		(error: unknown) => void (outcome = { error }),
	);
	let didKill = false;
	void killed.promise.then(() => void (didKill = true));
	await until(() => didKill, "the kill point fired");
	if (kill.at !== "committed") hand = startHand();
	await until(() => outcome !== undefined, "the turn got the hook call's outcome");
	// Let any second dispatch the restart could cause surface before the run count is checked.
	for (let step = 0; step < 40; step++) {
		await timers.advanceTo(timers.now() + TICK_MS);
		await drain();
	}

	if (kill.outcome === "result") {
		expectEqual(
			outcome !== undefined && "result" in outcome ? outcome.result : outcome,
			{ context: 'hook saw {"prompt":"go"}' },
			`${what}: the hook result`,
		);
		expectEqual(requests.length, 1, `${what}: provider requests`);
	} else {
		expectEqual(
			outcome !== undefined && "error" in outcome && outcome.error instanceof LoopHookRestartedError,
			true,
			`${what}: the call ended restarted`,
		);
		expectEqual(requests.length, 0, `${what}: provider requests`);
	}
	expectEqual(runs.length, kill.runs, `${what}: hook runs`);
	expectEqual(host.waiting(), [], `${what}: nothing left waiting`);
}

const cases = KILLS.map((kill, index) => {
	const id = `KILL-HOOK-${String(index + 1).padStart(2, "0")}`;
	const declaration: KillHookDeclaration = { id, at: kill.at, expected: expectedOf(kill) };
	const run: CaseImplementation<TransportCaseAdapters> = (adapters) =>
		runKillCase(adapters, kill, `${id} (${kill.at})`);
	return { declaration, run };
});

export const KILL_HOOK_DECLARATIONS: readonly KillHookDeclaration[] = cases.map(({ declaration }) => declaration);
export const KILL_HOOK_CASES: ReadonlyMap<string, CaseImplementation<TransportCaseAdapters>> = new Map(
	cases.map(({ declaration, run }) => [declaration.id, run]),
);
