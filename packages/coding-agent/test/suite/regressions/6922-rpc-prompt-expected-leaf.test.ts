import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createIdentityHarness } from "../rpc-client-identity-harness.ts";

// senpi#6922: a prompt that names the leaf it was decided at is refused with stale_leaf when the session moved,
// and nothing is appended or sent to the model; a matching or omitted leaf proceeds as before.
describe("RPC prompt that names its leaf", () => {
	const fixtures: Awaited<ReturnType<typeof createIdentityHarness>>[] = [];
	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) await fixture.cleanup();
	});

	const setup = async () => {
		const fixture = await createIdentityHarness();
		fixtures.push(fixture);
		fixture.harness.setResponses([
			fauxAssistantMessage("first answer"),
			fauxAssistantMessage("second answer"),
			fauxAssistantMessage("third answer"),
		]);
		let providerCalls = 0;
		const stream = fixture.harness.agent.streamFunction;
		fixture.harness.agent.streamFunction = (model, context, options) => {
			providerCalls += 1;
			return stream(model, context, options);
		};
		const rpc = fixture.bind();
		const promptSettled = async (command: object) => {
			const response = await rpc.send({ type: "prompt", ...command });
			await fixture.session.waitForIdle();
			return response as { success?: boolean; errorCode?: string };
		};
		await promptSettled({ message: "first" });
		const leaf = fixture.session.sessionManager.getLeafId();
		if (leaf === null) throw new Error("the first turn left no leaf");
		return { fixture, promptSettled, leaf, providerCalls: () => providerCalls };
	};

	it("refuses a stale expected leaf with stale_leaf and sends nothing", async () => {
		const { fixture, promptSettled, leaf, providerCalls } = await setup();
		const callsBefore = providerCalls();
		const entriesBefore = fixture.session.sessionManager.getEntries().length;

		const response = await promptSettled({ message: "late", expectedLeafId: "entry-that-moved-on" });

		expect(response.success).toBe(false);
		expect(response.errorCode).toBe("stale_leaf");
		expect(providerCalls()).toBe(callsBefore);
		expect(fixture.session.sessionManager.getEntries().length).toBe(entriesBefore);
		expect(fixture.session.sessionManager.getLeafId()).toBe(leaf);
	});

	it("runs a prompt whose expected leaf matches the current leaf", async () => {
		const { fixture, promptSettled, leaf, providerCalls } = await setup();
		const callsBefore = providerCalls();

		const response = await promptSettled({ message: "on time", expectedLeafId: leaf });

		expect(response.success).toBe(true);
		expect(providerCalls()).toBe(callsBefore + 1);
		expect(fixture.session.sessionManager.getLeafId()).not.toBe(leaf);
	});

	it("runs a prompt that omits the expected leaf, as before", async () => {
		const { promptSettled, providerCalls } = await setup();
		const callsBefore = providerCalls();

		const response = await promptSettled({ message: "no guard" });

		expect(response.success).toBe(true);
		expect(providerCalls()).toBe(callsBefore + 1);
	});
});
