import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { getAssistantTexts } from "./harness.ts";
import { createIdentityHarness } from "./rpc-client-identity-harness.ts";

// Queue dequeue and queued-to-running persistence must be one observable transition.
it.each(["steer", "follow_up"])("reports %s as running while its own answer is in flight", async (type) => {
	// Given
	const fixture = await createIdentityHarness();
	fixture.harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("queued")]);
	const firstEntered = Promise.withResolvers<void>();
	const secondEntered = Promise.withResolvers<void>();
	const firstRelease = Promise.withResolvers<void>();
	const secondRelease = Promise.withResolvers<void>();
	const stream = fixture.harness.agent.streamFunction;
	let requests = 0;
	fixture.harness.agent.streamFunction = async (model, context, options) => {
		requests++;
		if (requests === 1) {
			firstEntered.resolve();
			await firstRelease.promise;
		} else {
			secondEntered.resolve();
			await secondRelease.promise;
		}
		return stream(model, context, options);
	};
	const rpc = fixture.bind();
	try {
		await rpc.send({ type: "prompt", message: "hold", clientMessageId: "initial" });
		await firstEntered.promise;
		const command = { type, message: "next", clientMessageId: "next" };
		await rpc.send(command);
		firstRelease.resolve();
		await secondEntered.promise;

		// When
		const repeated = await rpc.send(command);
		secondRelease.resolve();
		await Promise.all(rpc.handler.pendingPrompts());

		// Then
		expect(repeated).toMatchObject({ success: true, data: { admission: { state: "running" } } });
		expect(getAssistantTexts(fixture.harness)).toEqual(["first", "queued"]);
		expect(requests).toBe(2);
	} finally {
		firstRelease.resolve();
		secondRelease.resolve();
		await fixture.cleanup();
	}
});
