/**
 * egress-conformance for the device route (CK9 on the CK22 harness): the real `AgentSession` / `Agent` / agent loop of
 * `createHostedHarness` with `DeviceProxyEgress` as the loop's stream function and a hosted `commitStep` that writes
 * history and the ledger close in one mutation (W9). KILL points live in `egress-conformance-kill.test.ts`.
 */
import type { AgentLoopConfig, EgressHostHooks, StepRef } from "@earendil-works/pi-agent-core";
import type { StoreWrite } from "@earendil-works/pi-agent-core/conformance";
import { type AssistantMessageEvent, normalizeContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createDeviceProxyEgress } from "../../src/core/egress/device-proxy.ts";
import { closeCallWrites } from "../../src/core/egress/ledger.ts";
import { requestPrefix } from "../../src/core/egress/ledger-schema.ts";
import { AT, claimFields, signClaim, trusted } from "./claim-fixture.ts";
import { createHandDouble, type HandDouble } from "./device-hand-double.ts";
import { conditionsDouble, ledgerOn, manualClock, storeFixture } from "./device-proxy-doubles.ts";
import { handRoute, rig } from "./device-proxy-fixture.ts";
import { createHostedHarness, type HostedHarness } from "./harness/index.ts";

interface LoopConfigOwner {
	createLoopConfig(...args: unknown[]): AgentLoopConfig;
}

const harnesses: HostedHarness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

/** One hosted session whose loop steps go through the device route to `hand`, on its own store. */
async function hostedSession(sessionId: string, hand: (respond: HostedHarness) => HandDouble) {
	const harness = await createHostedHarness();
	harnesses.push(harness);
	const store = await (await storeFixture()).open();
	const ledger = ledgerOn(store);
	const dial = harness.agent.streamFunction;
	const device = hand(harness);
	const claim = await signClaim(claimFields(), device.registry);
	let step: StepRef | undefined;
	const host: EgressHostHooks = {
		currentStep: () => {
			if (!step) throw new Error("no admitted step");
			return step;
		},
		admitAux: () => Promise.reject(new Error("aux calls belong to CK25")),
		onWait: async () => {},
		onWaitEnd: async () => {},
		historyHasStep: async (stepId) => (await store.getDocument(`history/${stepId}`)) !== undefined,
	};
	const egress = createDeviceProxyEgress({
		sessionId,
		host,
		ledger,
		hands: { channel: () => device, offlineFor: () => 0 },
		route: {
			decide: () => handRoute(),
			headDigest: () => "digest-head",
			capability: () => "stream",
			liveDigest: () => undefined,
		},
		claims: { current: async () => claim, renew: async () => {} },
		requestHooks: async (_hand, request) => request,
		conditions: conditionsDouble(),
		notify: () => {},
		clock: manualClock(),
		bounds: { idleMs: 60_000, resumeWindowMs: 5_000, deadlineMs: 600_000 },
	});
	let admissions = 0;
	harness.agent.streamFunction = async (model, context, options) => {
		admissions += 1;
		step = {
			kind: "step",
			sessionId,
			stepId: `step-${admissions}`,
			attempt: 1,
			fence: { epoch: 1, admissionSeq: admissions, generation: 1 },
		};
		await store.commit(1, [{ op: "put", key: "session/step", data: step.stepId }], () => {});
		return egress.stream(model, context, options);
	};
	const owner = harness.agent as unknown as LoopConfigOwner;
	const withHostedCommit = owner.createLoopConfig.bind(harness.agent);
	owner.createLoopConfig = (...args: unknown[]) => {
		const config = withHostedCommit(...args);
		return {
			...config,
			commitStep: async (committed) => {
				await config.commitStep?.(committed);
				if (!step) throw new Error("commit without an admitted step");
				const live = (await ledger.rowsForStep(step.stepId)).at(-1);
				const writes: StoreWrite[] = [
					{ op: "put", key: `history/${step.stepId}`, data: JSON.stringify(committed.message) },
					{ op: "delete", key: "session/step" },
					...(live ? closeCallWrites(live) : []),
				];
				await store.commit(1, writes, () => {});
			},
		};
	};
	return { harness, store, ledger, device, dial, egress };
}

const fauxHand = (
	deviceId: string,
	sessions: Map<string, HostedHarness>,
	dials: Map<string, HostedHarness["agent"]["streamFunction"]>,
) =>
	trusted().then(({ reg, trust }) =>
		createHandDouble({
			deviceId,
			registry: reg,
			trust,
			clock: AT,
			respond: async (start, request) => {
				const harness = sessions.get(start.sessionId);
				const dial = dials.get(start.sessionId);
				if (!harness || !dial || !("context" in request)) throw new Error(`unknown session ${start.sessionId}`);
				return collect(await dial(harness.getModel(), request.context, request.options));
			},
		}),
	);

const assistantText = (harness: HostedHarness): string | undefined => {
	const last = harness.session.messages.at(-1);
	if (last?.role !== "assistant") return undefined;
	return last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
};

describe("egress-conformance: real AgentSession on the device route (CK9 + CK22)", () => {
	it("commits one step once: history row, ledger row closed, request chunks gone, call acked", async () => {
		const sessions = new Map<string, HostedHarness>();
		const dials = new Map<string, HostedHarness["agent"]["streamFunction"]>();
		const hand = await fauxHand("laptop", sessions, dials);
		const wired = await hostedSession("s-1", () => hand);
		sessions.set("s-1", wired.harness);
		dials.set("s-1", wired.dial);
		wired.harness.setResponses([fauxAssistantMessage("from the device")]);
		await wired.harness.session.prompt("hi");
		await wired.harness.session.waitForIdle();

		const [row] = await wired.ledger.rowsForStep("step-1");
		expect(assistantText(wired.harness)).toBe("from the device");
		expect(wired.harness.commits.map((commit) => commit.outcome)).toEqual(["committed"]);
		expect(await wired.store.getDocument("history/step-1")).toBeDefined();
		expect(row?.state).toBe("closed");
		expect(await wired.store.scanDocuments(requestPrefix(row?.callId ?? ""))).toEqual([]);
		expect(hand.acks).toEqual([row?.callId]);
		expect(hand.executions).toBe(1);
	});

	it("serves three sessions on one device without crossing their calls (MULTI)", async () => {
		const sessions = new Map<string, HostedHarness>();
		const dials = new Map<string, HostedHarness["agent"]["streamFunction"]>();
		const hand = await fauxHand("laptop", sessions, dials);
		const wired = await Promise.all(["s-1", "s-2", "s-3"].map((id) => hostedSession(id, () => hand)));
		wired.forEach((entry, index) => {
			const id = `s-${index + 1}`;
			sessions.set(id, entry.harness);
			dials.set(id, entry.dial);
			entry.harness.setResponses([fauxAssistantMessage(`answer ${id}`)]);
		});
		await Promise.all(wired.map((entry, index) => entry.harness.session.prompt(`question ${index + 1}`)));
		await Promise.all(wired.map((entry) => entry.harness.session.waitForIdle()));

		expect(wired.map((entry) => assistantText(entry.harness))).toEqual(["answer s-1", "answer s-2", "answer s-3"]);
		expect(hand.executions).toBe(3);
		expect(new Set(hand.starts.map((start) => start.sessionId))).toEqual(new Set(["s-1", "s-2", "s-3"]));
		for (const entry of wired)
			expect((await entry.ledger.rowsForStep("step-1")).map((row) => row.state)).toEqual(["closed"]);
	});

	it("leaves a rejected commit's ended row for one replay without contacting the device", async () => {
		const sessions = new Map<string, HostedHarness>();
		const dials = new Map<string, HostedHarness["agent"]["streamFunction"]>();
		const hand = await fauxHand("laptop", sessions, dials);
		const wired = await hostedSession("s-1", () => hand);
		sessions.set("s-1", wired.harness);
		dials.set("s-1", wired.dial);
		wired.harness.setResponses([fauxAssistantMessage("stored once")]);
		wired.harness.inject.nextCommit("reject");
		await wired.harness.session.prompt("hi").catch(() => undefined);
		await wired.harness.session.waitForIdle();
		const [row] = await wired.ledger.rowsForStep("step-1");
		expect(wired.harness.commits.map((commit) => commit.outcome)).toEqual(["rejected"]);
		expect(row?.state).toBe("ended");

		const replay = await rig({ store: wired.store, respond: async () => [], hands: new Map([["laptop", hand]]) });
		const replayed = await replay.egress.stream(wired.harness.getModel(), normalizeContext({ messages: [] }), {});
		const events = await collect(replayed);
		expect(events.at(-1)?.type).toBe("done");
		expect((await replayed.result()).content).toEqual([{ type: "text", text: "stored once" }]);
		expect(hand.starts).toHaveLength(1);
	});
});
