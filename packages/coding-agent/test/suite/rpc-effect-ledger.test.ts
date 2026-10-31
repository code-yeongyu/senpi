import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { EFFECT_OUTCOMES, unknownModelOutcome } from "../../src/modes/rpc/effect-outcome-copy.ts";
import { EFFECT_LEDGER_CAPABILITY, effectFingerprint, RPC_EFFECT_ENTRY } from "../../src/modes/rpc/effect-record.ts";
import { multiSessionHostCapabilities } from "../../src/modes/rpc/host-capabilities.ts";
import { createIdentityHarness } from "./rpc-client-identity-harness.ts";

type Fixture = Awaited<ReturnType<typeof createIdentityHarness>>;
type Wire = Record<string, unknown> & { success?: boolean; errorCode?: string; data?: Record<string, unknown> };

const effectEntries = (fixture: Fixture, effectId: string) =>
	fixture.session.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === RPC_EFFECT_ENTRY)
		.map((entry) => (entry.type === "custom" ? entry.data : undefined))
		.filter((data): data is { effectId: string; state: string } =>
			Boolean(data && typeof data === "object" && Reflect.get(data, "effectId") === effectId),
		);

describe("RPC effect ledger", () => {
	const fixtures: Fixture[] = [];
	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) await fixture.cleanup();
	});
	const setup = async () => {
		const fixture = await createIdentityHarness({ models: [{ id: "faux-a" }, { id: "faux-b" }] });
		fixtures.push(fixture);
		fixture.harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		return fixture;
	};
	/** Holds the provider call until the abort signal fires, so the turn is streaming when it is aborted. */
	const holdUntilAborted = (fixture: Fixture) => {
		const entered = Promise.withResolvers<void>();
		const stream = fixture.harness.agent.streamFunction;
		fixture.harness.agent.streamFunction = async (model, context, options) => {
			entered.resolve();
			await new Promise<void>((resolve) => {
				if (options?.signal?.aborted) resolve();
				else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			return stream(model, context, options);
		};
		return entered.promise;
	};
	const nextIdle = (fixture: Fixture) =>
		new Promise<void>((resolve) => {
			const off = fixture.session.subscribe((event) => {
				if (event.type !== "agent_idle") return;
				off();
				resolve();
			});
		});

	it("records an abort as accepted before the agent sees it, then applied, then done at idle", async () => {
		// Given: a streaming turn and a spy on the agent's abort.
		const fixture = await setup();
		const rpc = fixture.bind();
		const entered = holdUntilAborted(fixture);
		await rpc.send({ type: "prompt", message: "hold" });
		await entered;
		const statesAtAbort: string[][] = [];
		const agentAbort = fixture.session.agent.abort.bind(fixture.session.agent);
		fixture.session.agent.abort = () => {
			statesAtAbort.push(effectEntries(fixture, "a1").map((entry) => entry.state));
			agentAbort();
		};
		const idle = nextIdle(fixture);

		// When
		const response = (await rpc.send({ type: "abort", effectId: "a1" })) as Wire;
		await idle;

		// Then
		expect(statesAtAbort[0]).toEqual(["accepted"]);
		expect(response).toMatchObject({ success: true, data: { effectId: "a1", state: "applied" } });
		expect(effectEntries(fixture, "a1").map((entry) => entry.state)).toEqual(["accepted", "applied", "done"]);
		const status = (await rpc.send({ type: "get_effect_status", effectId: "a1" })) as Wire;
		expect(status).toMatchObject({ data: { found: true, effect: { kind: "abort", state: "done" } } });
	});

	it("replays the same id and payload without a second abort, and refuses the id for another payload", async () => {
		// Given: an abort already recorded on an idle session.
		const fixture = await setup();
		const rpc = fixture.bind();
		let aborts = 0;
		const agentAbort = fixture.session.agent.abort.bind(fixture.session.agent);
		fixture.session.agent.abort = () => {
			aborts++;
			agentAbort();
		};
		const first = (await rpc.send({ type: "abort", effectId: "e1" })) as Wire;
		const abortsAfterFirst = aborts;
		const entriesAfterFirst = effectEntries(fixture, "e1").map((entry) => entry.state);

		// When
		const replay = (await rpc.send({ type: "abort", effectId: "e1" })) as Wire;
		const conflict = (await rpc.send({ type: "abort", effectId: "e1", graceMs: 1 })) as Wire;

		// Then
		expect(first).toMatchObject({ data: { state: "done", effect: { disposition: "no_active_turn" } } });
		expect(replay).toMatchObject({ success: true, data: { effectId: "e1", replayed: true, state: "done" } });
		expect(aborts).toBe(abortsAfterFirst);
		expect(conflict).toMatchObject({ success: false, errorCode: "effect_id_conflict" });
		expect(conflict.errorData).toMatchObject({
			effectId: "e1",
			reason: expect.any(String),
			action: expect.any(String),
		});
		expect(entriesAfterFirst).toEqual(["accepted", "done"]);
		expect(effectEntries(fixture, "e1").map((entry) => entry.state)).toEqual(entriesAfterFirst);
	});

	it("hashes only the semantic fields of an effect", () => {
		const fingerprint = (payload: object) => effectFingerprint("abort", payload);
		expect(fingerprint({ id: "a", sessionId: "rpc-1", effectId: "x" })).toBe(
			fingerprint({ id: "b", sessionId: "rpc-7", effectId: "y" }),
		);
		expect(fingerprint({ graceMs: 1 })).not.toBe(fingerprint({ graceMs: 2 }));
		expect(effectFingerprint("set_model", { provider: "p", modelId: "a" })).not.toBe(
			effectFingerprint("set_model", { provider: "p", modelId: "b" }),
		);
	});

	it("marks set_model done once model_changed carries the id, and a refused model failed with reason and action", async () => {
		// Given
		const fixture = await setup();
		const rpc = fixture.bind();
		const target = fixture.harness.getModel("faux-b");
		if (!target) throw new Error("fixture model faux-b is missing");

		// When
		const applied = (await rpc.send({
			type: "set_model",
			provider: target.provider,
			modelId: target.id,
			effectId: "m1",
		})) as Wire;
		const refused = (await rpc.send({
			type: "set_model",
			provider: target.provider,
			modelId: "missing",
			effectId: "m2",
		})) as Wire;
		const status = (await rpc.send({ type: "get_effect_status", effectId: "m2" })) as Wire;

		// Then
		expect(applied).toMatchObject({ success: true, data: { id: "faux-b", effectId: "m1", state: "done" } });
		const switched = fixture.session.sessionManager.getEntries().filter((entry) => entry.type === "model_change");
		expect(switched.at(-1)).toMatchObject({ modelId: "faux-b", effectId: "m1" });
		expect(refused).toMatchObject({ success: false, errorCode: "model_not_found" });
		expect(status).toMatchObject({
			data: { found: true, effect: { state: "failed", outcome: unknownModelOutcome(target.provider, "missing") } },
		});
	});

	it("answers the newest state by id, and found: false only after the whole ledger was searched", async () => {
		// Given
		const fixture = await setup();
		const rpc = fixture.bind();
		await rpc.send({ type: "set_thinking_level", level: "high", effectId: "t1" });

		// When
		const known = (await rpc.send({ type: "get_effect_status", effectId: "t1" })) as Wire;
		const absent = (await rpc.send({ type: "get_effect_status", effectId: "never-sent" })) as Wire;

		// Then
		expect(known).toMatchObject({ data: { found: true, effect: { kind: "set_thinking_level", state: "done" } } });
		expect(absent).toMatchObject({ data: { found: false, searched: "complete" } });
	});

	it("advertises effect_ledger on classic and multi-session hosts", async () => {
		const fixture = await setup();
		const info = (await fixture.bind().send({ type: "get_protocol_info" })) as Wire;
		expect(info.data?.capabilities).toContain(EFFECT_LEDGER_CAPABILITY);
		expect(multiSessionHostCapabilities({ warm: false, toolRuntime: "in-process", negotiated: [] })).toContain(
			EFFECT_LEDGER_CAPABILITY,
		);
	});

	it("writes nothing for an abort without effectId", async () => {
		// Given
		const fixture = await setup();
		const rpc = fixture.bind();
		const before = fixture.session.sessionManager.getEntries().length;

		// When
		const response = (await rpc.send({ type: "abort" })) as Wire;

		// Then
		expect(response).toEqual({ id: expect.any(String), type: "response", command: "abort", success: true });
		expect(fixture.session.sessionManager.getEntries()).toHaveLength(before);
	});

	it("seals what a reopen finds before any retry can replay it", async () => {
		// Given: a set_model receipt left accepted, as a process that died mid-switch leaves it.
		const fixture = await setup();
		const rpc = fixture.bind();
		await rpc.handler.ready;
		await fixture.session.sessionManager.persistHeaderNow();
		const base = { by: { connectionId: "gone" }, acceptedAt: "t", updatedAt: "t" };
		const durableSessionId = fixture.session.sessionManager.getSessionId();
		fixture.session.sessionManager.appendCustomEntry(RPC_EFFECT_ENTRY, {
			...base,
			effectId: "seal-model",
			kind: "set_model",
			state: "accepted",
			durableSessionId,
			fingerprint: effectFingerprint("set_model", { provider: "p", modelId: "m" }),
		});

		// When
		const reopened = await fixture.reopen();
		const model = (await reopened.send({ type: "get_effect_status", effectId: "seal-model" })) as Wire;
		const retry = (await reopened.send({
			type: "set_model",
			provider: "p",
			modelId: "m",
			effectId: "seal-model",
		})) as Wire;

		// Then
		expect(model).toMatchObject({
			data: { effect: { state: "failed", outcome: EFFECT_OUTCOMES.setModelInterruptedByReopen } },
		});
		expect(retry).toMatchObject({ success: true, data: { replayed: true, state: "failed" } });
	});
});
