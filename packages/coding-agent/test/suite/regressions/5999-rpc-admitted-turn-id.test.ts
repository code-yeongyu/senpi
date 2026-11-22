import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createIdentityHarness } from "../rpc-client-identity-harness.ts";

// senpi#5999: an admission names the engine turn it started, independently of caller correlation.
describe("RPC admitted turn identity", () => {
	const fixtures: Awaited<ReturnType<typeof createIdentityHarness>>[] = [];
	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) await fixture.cleanup();
	});

	const setup = async () => {
		const fixture = await createIdentityHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("handled", { description: "Handle without a turn", handler: async () => {} });
				},
			],
		});
		fixtures.push(fixture);
		fixture.harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		let release = Promise.withResolvers<void>();
		const stream = fixture.harness.agent.streamFunction;
		fixture.harness.agent.streamFunction = async (model, context, options) => {
			const aborted = new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve()));
			await Promise.race([release.promise, aborted]);
			return stream(model, context, options);
		};
		return {
			fixture,
			rpc: fixture.bind(),
			release: () => release.resolve(),
			holdNext: () => {
				release = Promise.withResolvers<void>();
			},
		};
	};

	it.each([
		{ name: "anonymous prompt", type: "prompt", identified: false },
		{ name: "identified prompt", type: "prompt", identified: true },
		{ name: "idle-start steer", type: "steer", identified: true },
		{ name: "idle-start follow-up", type: "follow_up", identified: true },
	])("names the actual turn for $name before its message event", async ({ type, identified }) => {
		const { fixture, rpc, release } = await setup();
		const identity = identified ? { clientMessageId: "first-input", clientTurnId: "caller-correlation" } : {};
		try {
			const response = await rpc.send({
				type,
				message: "first",
				...identity,
				...(type === "prompt" ? {} : { whenIdle: "start" }),
			});
			expect(response).toMatchObject({ success: true, data: { disposition: "started", turnId: "1" } });
			expect(await rpc.send({ type: "get_state" })).toMatchObject({ data: { currentTurnId: "1" } });
			if (identified) {
				expect(response).toMatchObject({
					data: { clientTurnId: "caller-correlation", admission: { disposition: "started", turnId: "1" } },
				});
			}
		} finally {
			release();
		}
		await Promise.all(rpc.handler.pendingPrompts());
		const records = rpc.messages();
		const responseIndex = records.findIndex((record) => record.type === "response" && record.command === type);
		const messageIndex = records.findIndex((record) => record.type === "message_start");
		expect(responseIndex).toBeGreaterThanOrEqual(0);
		expect(responseIndex).toBeLessThan(messageIndex);
		expect(fixture.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
	});

	it("replays the original admitted turn while another turn runs and after reopening", async () => {
		const { fixture, rpc, release, holdNext } = await setup();
		const first = { type: "prompt", message: "first", clientMessageId: "original" };
		try {
			await rpc.send(first);
			release();
			await Promise.all(rpc.handler.pendingPrompts());
			holdNext();
			await rpc.send({ type: "prompt", message: "second" });
			expect(await rpc.send({ type: "get_state" })).toMatchObject({ data: { currentTurnId: "2" } });
			expect(await rpc.send(first)).toMatchObject({
				data: { disposition: "started", turnId: "1", admission: { turnId: "1", state: "completed" } },
			});
		} finally {
			release();
		}
		await Promise.all(rpc.handler.pendingPrompts());
		const reopened = await fixture.reopen();
		expect(await reopened.send(first)).toMatchObject({
			data: { disposition: "started", turnId: "1", admission: { turnId: "1", state: "completed" } },
		});
		// Reopen creates a fresh Agent; the transcript owns the already delivered messages.
		expect(
			fixture.session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "message" && entry.message.role === "user"),
		).toHaveLength(2);
	});

	it("settles a turn when its admission callback throws EISDIR", async () => {
		const { fixture, release } = await setup();
		const storageError = Object.assign(new Error("EISDIR: cannot persist admission"), { code: "EISDIR" });
		let admittedTurn: string | undefined;
		try {
			await expect(
				fixture.session.prompt("rejected before the user message", {
					source: "rpc",
					interactiveUser: false,
					onTurnAdmitted: () => {
						admittedTurn = fixture.session.currentTurnId;
						throw storageError;
					},
				}),
			).rejects.toBe(storageError);
			expect(admittedTurn).toBe("1");
			expect(fixture.session.currentTurnId).toBeUndefined();
			expect(fixture.session.messages.filter((message) => message.role === "user")).toHaveLength(0);
		} finally {
			release();
		}
	});

	it("does not assign the running turn to handled or queued input", async () => {
		const { rpc, release } = await setup();
		try {
			await rpc.send({ type: "prompt", message: "first" });
			for (const command of [
				{ type: "prompt", message: "/handled", clientMessageId: "handled" },
				{ type: "prompt", message: "queued", streamingBehavior: "followUp", clientMessageId: "queued" },
			]) {
				const response = await rpc.send(command);
				expect(response).toMatchObject({ success: true });
				expect(response.data).not.toHaveProperty("turnId");
				expect(response.data).toHaveProperty("admission");
				expect(response.data).not.toHaveProperty("admission.turnId");
			}
			await rpc.send({ type: "clear_queue" });
		} finally {
			release();
		}
		await Promise.all(rpc.handler.pendingPrompts());
	});
});
