import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { EngineTurnHold, type SessionHoldEvent } from "../../../src/core/engine-turn-hold.ts";
import type { ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/types.ts";
import { createIdentityHarness } from "../rpc-client-identity-harness.ts";

type Fixture = Awaited<ReturnType<typeof createIdentityHarness>>;
type RunRef = { kind: "dag" | "task" | "workpool" | "team"; id: string };

interface Probe {
	api?: ExtensionAPI;
	context?: ExtensionContext;
}

const runR: RunRef = { kind: "dag", id: "r1" };
const runR2: RunRef = { kind: "dag", id: "r2" };

async function fencedFixture(): Promise<{
	fixture: Fixture;
	probe: Probe;
	pausedKinds: string[];
	resumedCauses: string[];
}> {
	const probe: Probe = {};
	const fixture = await createIdentityHarness({
		extensionFactories: [
			(pi: ExtensionAPI) => {
				probe.api = pi;
				pi.on("session_start", (_event, ctx) => {
					probe.context = ctx;
				});
			},
		],
	});
	await fixture.session.bindExtensions({ mode: "rpc" });
	fixture.harness.setResponses([fauxAssistantMessage("the cancelled run's wake ran a turn")]);
	const pausedKinds: string[] = [];
	const resumedCauses: string[] = [];
	fixture.session.subscribe((event) => {
		const type: string = event.type;
		if (type === "session_paused") pausedKinds.push(String(Reflect.get(event, "kind")));
		if (type === "session_resumed") resumedCauses.push(String(Reflect.get(event, "cause")));
	});
	probe.context?.fenceRun?.(runR);
	probe.context?.fenceRun?.(runR2);
	return { fixture, probe, pausedKinds, resumedCauses };
}

function fenceKeys(probe: Probe): string[] {
	return (probe.context?.getPauseState?.().holds ?? [])
		.filter((hold) => hold.kind === "run_fence")
		.map((hold) => hold.key);
}

function wakeOutcome(fixture: Fixture): Promise<"turn" | "notice"> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			unsubscribe();
			reject(new Error("the run-tagged wake produced neither a turn nor a notice"));
		}, 10_000);
		const unsubscribe = fixture.session.subscribe((event) => {
			const type: string = event.type;
			const kind = type === "agent_start" ? "turn" : type === "session_notice" ? "notice" : undefined;
			if (kind === undefined) return;
			clearTimeout(timer);
			unsubscribe();
			resolve(kind);
		});
	});
}

async function wakeFor(fixture: Fixture, probe: Probe, runRef: RunRef): Promise<"turn" | "notice"> {
	const outcome = wakeOutcome(fixture);
	probe.api?.sendMessage(
		{
			customType: "senpi-task.completion",
			content: `child of ${runRef.id} finished`,
			display: false,
			details: { runRef },
		},
		{ triggerTurn: true },
	);
	const kind = await outcome;
	await fixture.session.waitForIdle();
	return kind;
}

describe("senpi#3811 workflow cancel releases the parent's run fence", () => {
	const fixtures: Fixture[] = [];
	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) await fixture.cleanup();
	});

	it("drops only the cancelled run's fence and admits that run's later wake as a turn", async () => {
		const { fixture, probe } = await fencedFixture();
		fixtures.push(fixture);
		const rpc = fixture.bind();

		probe.context?.releaseRunFence?.(runR);

		expect(fenceKeys(probe)).toEqual(["run_fence:dag:r2"]);
		const state = (await rpc.send({ type: "get_state" })) as { data: { paused?: boolean } };
		expect(state.data.paused).toBe(false);
		expect(await wakeFor(fixture, probe, runR)).toBe("turn");
		expect(fixture.harness.faux.state.callCount).toBe(1);
		expect(await wakeFor(fixture, probe, runR2)).toBe("notice");
		expect(fixture.harness.faux.state.callCount).toBe(1);
	});

	it("never reports a pause or a resume for fences alone, which do not pause the session", async () => {
		const { fixture, probe, pausedKinds, resumedCauses } = await fencedFixture();
		fixtures.push(fixture);

		probe.context?.releaseRunFence?.(runR);
		probe.context?.releaseRunFence?.(runR2);

		expect(fenceKeys(probe)).toEqual([]);
		expect(pausedKinds).toEqual([]);
		expect(resumedCauses).toEqual([]);
	});

	it("emits one session_resumed for the Stop it pairs with when a fence outlives that Stop", () => {
		// Given a stopped ledger whose Stop also fenced a run
		const events: SessionHoldEvent[] = [];
		const ledger = new EngineTurnHold(
			[],
			false,
			() => "entry",
			() => {},
			(event) => {
				events.push(event);
			},
		);
		ledger.addHold("session_hold", { key: "session_hold:1" });
		ledger.addHold("run_fence", { key: "run_fence:dag:r1", data: { runRef: runR } });

		// When the Stop is released on its own, and the run is cancelled later
		ledger.release(["session_hold:1"], "resume_session");
		ledger.release(["run_fence:dag:r1"], "run_cancelled");

		// Then the one pause has exactly one resume
		expect(
			events.flatMap((event) =>
				event.type === "session_paused" || event.type === "session_resumed" ? [event.type] : [],
			),
		).toEqual(["session_paused", "session_resumed"]);
	});

	it("treats releasing a run that holds no fence as a no-op", async () => {
		const { fixture, probe, resumedCauses } = await fencedFixture();
		fixtures.push(fixture);
		const before = probe.context?.getPauseState?.();

		probe.context?.releaseRunFence?.({ kind: "task", id: "never-fenced" });

		expect(probe.context?.getPauseState?.()).toEqual(before);
		expect(fenceKeys(probe)).toEqual(["run_fence:dag:r1", "run_fence:dag:r2"]);
		expect(resumedCauses).toEqual([]);
	});
});
