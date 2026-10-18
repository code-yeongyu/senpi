import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createIdentityHarness } from "./rpc-client-identity-harness.ts";

type Fixture = Awaited<ReturnType<typeof createIdentityHarness>>;

describe("RPC interrupt effect actor", () => {
	const fixtures: Fixture[] = [];
	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) await fixture.cleanup();
	});
	const setup = async () => {
		const fixture = await createIdentityHarness();
		fixtures.push(fixture);
		fixture.harness.setResponses([fauxAssistantMessage("stopped")]);
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
		const rpc = fixture.bind();
		await rpc.send({ type: "prompt", message: "hold", clientMessageId: "input" });
		await entered.promise;
		return { fixture, rpc };
	};

	it("records the actor only when interrupt stops the requested turn", async () => {
		const { rpc } = await setup();
		expect(await rpc.send({ type: "interrupt" })).toMatchObject({ data: { interrupted: true } });
		expect(await rpc.send({ type: "get_effect_status", effectId: "input" })).toMatchObject({
			data: { effect: { state: "done", outcome: { kind: "aborted", abortedBy: { connectionId: "local" } } } },
		});
	});

	it("does not attribute a stale turn interrupt to an unrelated abort", async () => {
		const { fixture, rpc } = await setup();
		expect(await rpc.send({ type: "interrupt", turnId: "stale" })).toMatchObject({
			data: { interrupted: false },
		});
		await fixture.session.abort();
		const status = await rpc.send({ type: "get_effect_status", effectId: "input" });
		expect(status).toMatchObject({ data: { effect: { outcome: { kind: "aborted" } } } });
		expect(status).not.toMatchObject({
			data: { effect: { outcome: { abortedBy: { connectionId: "local" } } } },
		});
	});
});
