import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { CLIENT_ADMISSION_ENTRY } from "../../src/modes/rpc/client-admission-record.ts";
import { handleClientInput } from "../../src/modes/rpc/client-input-handler.ts";
import type { HarnessOptions } from "./harness.ts";
import { createIdentityHarness } from "./rpc-client-identity-harness.ts";

const assistantEntries = (fixture: Awaited<ReturnType<typeof createIdentityHarness>>) =>
	fixture.session.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "message" && entry.message.role === "assistant");

// senpi#2547 review: the admission ledger must survive what the transcript and the wire can hold.
describe("RPC client admission ledger", () => {
	const fixtures: Awaited<ReturnType<typeof createIdentityHarness>>[] = [];
	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) await fixture.cleanup();
	});
	const setup = async (options: HarnessOptions = {}) => {
		const fixture = await createIdentityHarness(options);
		fixtures.push(fixture);
		fixture.harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		return fixture;
	};

	it.each(["steer", "follow_up"])("refuses a %s whose enqueueOrder is not a number", async (type) => {
		// Given
		const fixture = await setup();
		const rpc = fixture.bind();

		// When
		const refused = await rpc.send({ type, message: "late", clientMessageId: "bad-order", enqueueOrder: "2" });
		const accepted = await rpc.send({ type, message: "kept", clientMessageId: "good-order", enqueueOrder: 5 });
		const reopened = await fixture.reopen();
		const state = await reopened.send({ type: "get_state" });

		// Then
		expect(refused).toMatchObject({ success: false, error: expect.stringContaining("enqueueOrder") });
		expect(accepted).toMatchObject({ success: true });
		expect(state).toMatchObject({
			success: true,
			data: { ordered: [expect.objectContaining({ clientMessageId: "good-order", enqueueOrder: 5 })] },
		});
	});

	it("opens a transcript holding a malformed admission entry and still deduplicates", async () => {
		// Given
		const fixture = await setup();
		const first = fixture.bind();
		const kept = { type: "prompt", message: "before", clientMessageId: "kept" };
		await first.send(kept);
		await Promise.all(first.handler.pendingPrompts());
		fixture.session.sessionManager.appendCustomEntry(CLIENT_ADMISSION_ENTRY, { clientMessageId: "broken" });
		const reopened = await fixture.reopen();

		// When
		const repeated = await reopened.send(kept);
		const fresh = await reopened.send({ type: "prompt", message: "after", clientMessageId: "fresh" });
		await Promise.all(reopened.handler.pendingPrompts());

		// Then
		expect(repeated).toMatchObject({ success: true, data: { admission: { state: "completed" } } });
		expect(fresh).toMatchObject({ success: true });
		expect(assistantEntries(fixture)).toHaveLength(2);
	});

	it("keeps a started prompt that a competing run displaced when the host dies before delivering it", async () => {
		// Given
		const release = Promise.withResolvers<void>();
		const competingEntered = Promise.withResolvers<void>();
		let competing: Promise<void> | undefined;
		const fixture = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						const message: AgentMessage = { role: "user", content: "competing", timestamp: Date.now() };
						competing ??= fixture.harness.agent.prompt(message);
						await competingEntered.promise;
					});
				},
			],
		});
		const stream = fixture.harness.agent.streamFunction;
		fixture.harness.agent.streamFunction = async (model, context, options) => {
			competingEntered.resolve();
			await release.promise;
			return stream(model, context, options);
		};
		const rpc = fixture.bind();
		const command = { type: "prompt", message: "mine", clientMessageId: "displaced" };
		try {
			const displaced = rpc.waitFor(
				(record) =>
					record.type === "queue_update" &&
					Array.isArray(record.ordered) &&
					record.ordered.some((input: { clientMessageId?: string }) => input.clientMessageId === "displaced"),
				15_000,
			);
			const first = await rpc.send(command);
			await competingEntered.promise;
			await displaced;
			const restarted = await fixture.reopenAbandoned();

			// When
			const repeated = await restarted.send(command);

			// Then
			expect(first).toMatchObject({ success: true, data: { disposition: "started" } });
			expect(repeated).toMatchObject({ success: true, data: { admission: { state: "queued" } } });
			expect(fixture.session.getQueuedInputs()).toEqual([
				expect.objectContaining({ text: "mine", mode: "steer", clientMessageId: "displaced" }),
			]);
		} finally {
			release.resolve();
			await competing;
		}
	});

	it("admits a fresh delivery behind the queue it restores from the transcript", async () => {
		// Given
		const fixture = await setup();
		const rpc = fixture.bind();
		await rpc.send({ type: "follow_up", message: "restored", clientMessageId: "restored" });
		const restarted = await fixture.openSettled();
		const restoring = Promise.withResolvers<void>();
		const restore = restarted.restoreQueuedInput.bind(restarted);
		restarted.restoreQueuedInput = async (input) => {
			await restoring.promise;
			return restore(input);
		};
		const responses: object[] = [];
		const command = { id: "fresh", type: "follow_up", message: "fresh", clientMessageId: "fresh" } as const;

		// When
		const delivery = handleClientInput(restarted, command, {
			output: (record) => responses.push(record),
			promptCalls: new Set(),
		});
		// Every step of an unordered admission is a microtask, so one macrotask turn lets it finish.
		await new Promise<void>((resolve) => setImmediate(resolve));
		restoring.resolve();
		await delivery;

		// Then
		expect(responses).toEqual([expect.objectContaining({ id: "fresh", success: true })]);
		expect(restarted.getFollowUpMessages()).toEqual(["restored", "fresh"]);
		expect(restarted.getQueuedInputs().map((input) => input.clientMessageId)).toEqual(["restored", "fresh"]);
	});
});
