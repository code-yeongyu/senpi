import { afterEach, describe, expect, it } from "vitest";
import { effectFingerprint, RPC_EFFECT_ENTRY } from "../../src/modes/rpc/effect-record.ts";
import { createIdentityHarness } from "./rpc-client-identity-harness.ts";

type Fixture = Awaited<ReturnType<typeof createIdentityHarness>>;

describe("RPC thinking effect identity and reopen", () => {
	const fixtures: Fixture[] = [];
	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) await fixture.cleanup();
	});
	const setup = async () => {
		const fixture = await createIdentityHarness({ models: [{ id: "thinking-model", reasoning: true }] });
		fixtures.push(fixture);
		await fixture.bind().handler.ready;
		await fixture.session.sessionManager.persistHeaderNow();
		return fixture;
	};
	const leaveEffect = (fixture: Fixture) =>
		fixture.session.sessionManager.appendCustomEntry(RPC_EFFECT_ENTRY, {
			effectId: "thinking",
			kind: "set_thinking_level",
			state: "accepted",
			by: { connectionId: "gone" },
			acceptedAt: "2026-10-12T00:00:00.000Z",
			updatedAt: "2026-10-12T00:00:00.000Z",
			durableSessionId: fixture.session.sessionManager.getSessionId(),
			fingerprint: effectFingerprint("set_thinking_level", { level: "high" }),
		});

	it.each([undefined, "turn"] as const)("stamps the thinking entry for scope %s", async (scope) => {
		const fixture = await setup();
		const rpc = fixture.bind();
		await rpc.send({ type: "set_thinking_level", level: "high", scope, effectId: "thinking" });
		expect(
			fixture.session.sessionManager.getEntries().filter((e) => e.type === "thinking_level_change"),
		).toContainEqual(expect.objectContaining({ effectId: "thinking", thinkingLevel: "high" }));
		expect(await rpc.send({ type: "get_effect_status", effectId: "thinking" })).toMatchObject({
			data: { effect: { kind: "set_thinking_level", state: "done" } },
		});
	});

	it("derives an applied thinking effect from its transcript after a crash", async () => {
		const fixture = await setup();
		leaveEffect(fixture);
		fixture.session.sessionManager.appendThinkingLevelChange("high", undefined, {
			source: "rpc",
			effectId: "thinking",
		});
		const reopened = await fixture.reopen();
		expect(await reopened.send({ type: "get_effect_status", effectId: "thinking" })).toMatchObject({
			data: { effect: { kind: "set_thinking_level", state: "done", disposition: "applied" } },
		});
	});

	it.each([undefined, "turn"] as const)(
		"stamps a no-op thinking change for scope %s without a second selection",
		async (scope) => {
			const fixture = await setup();
			const rpc = fixture.bind();
			await rpc.send({ type: "set_thinking_level", level: "high", scope, effectId: "first" });
			const selected = fixture.harness.eventsOfType("thinking_level_changed").length;
			await rpc.send({ type: "set_thinking_level", level: "high", scope, effectId: "thinking" });
			expect(
				fixture.session.sessionManager.getEntries().filter((e) => e.type === "thinking_level_change"),
			).toContainEqual(expect.objectContaining({ effectId: "thinking", thinkingLevel: "high" }));
			expect(fixture.harness.eventsOfType("thinking_level_changed")).toHaveLength(selected);
		},
	);

	it("does not stamp an unchanged thinking level for a model effect", async () => {
		const fixture = await setup();
		const rpc = fixture.bind();
		const model = fixture.harness.getModel();
		await rpc.send({ type: "set_thinking_level", level: "high", effectId: "thinking" });
		const before = fixture.session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "thinking_level_change");

		await rpc.send({ type: "set_model", provider: model.provider, modelId: model.id, effectId: "model" });

		expect(
			fixture.session.sessionManager.getEntries().filter((entry) => entry.type === "thinking_level_change"),
		).toEqual(before);
		expect(await rpc.send({ type: "get_effect_status", effectId: "model" })).toMatchObject({
			data: { effect: { kind: "set_model", state: "done" } },
		});
	});

	it("seals an unapplied thinking effect with thinking-level reason and action", async () => {
		const fixture = await setup();
		leaveEffect(fixture);
		const reopened = await fixture.reopen();
		expect(await reopened.send({ type: "get_effect_status", effectId: "thinking" })).toMatchObject({
			data: {
				effect: {
					state: "failed",
					outcome: {
						kind: "interrupted_by_reopen",
						action: "send set_thinking_level again with a new effectId",
					},
				},
			},
		});
	});
});
