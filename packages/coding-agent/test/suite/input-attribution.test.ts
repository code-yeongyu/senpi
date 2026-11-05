import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { deliverAnswer } from "../../src/core/extensions/builtin/ask-user/tool.ts";
import type { ExtensionAPI, InputEvent } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./harness.ts";

type SeenInput = Pick<InputEvent, "text" | "source" | "attribution" | "streamingBehavior">;

const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});

/** A session whose first turn parks in a tool, so input sent meanwhile arrives mid-stream. */
async function streamingHarness() {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const seen: SeenInput[] = [];
	const waiters: PromiseWithResolvers<SeenInput>[] = [];
	const nextInput = () => {
		const waiter = Promise.withResolvers<SeenInput>();
		waiters.push(waiter);
		return waiter.promise;
	};
	let api: ExtensionAPI | undefined;
	const h = await createHarness({
		extensionFactories: [
			(pi) => {
				api = pi;
				pi.on("input", (event) => {
					const input = {
						text: event.text,
						source: event.source,
						attribution: event.attribution,
						streamingBehavior: event.streamingBehavior,
					};
					seen.push(input);
					for (const waiter of waiters.splice(0)) waiter.resolve(input);
				});
			},
		],
		tools: [
			{
				name: "barrier",
				label: "Barrier",
				description: "Wait for the test.",
				parameters: Type.Object({}),
				execute: async () => {
					entered.resolve();
					await release.promise;
					return { content: [{ type: "text", text: "released" }], details: {} };
				},
			},
		],
	});
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	h.setResponses([
		fauxAssistantMessage([fauxToolCall("barrier", {})], { stopReason: "toolUse" }),
		...Array.from({ length: 10 }, () => fauxAssistantMessage([fauxText("done")])),
	]);
	const extensionApi = (): ExtensionAPI => {
		if (!api) throw new Error("extension API not bound");
		return api;
	};
	return { h, entered, release, seen, nextInput, extensionApi };
}

describe("input event attribution (senpi#4471)", () => {
	it("attributes typed prompts and steers to the user", async () => {
		const { h, entered, release, seen } = await streamingHarness();
		const running = h.session.prompt("start");
		await entered.promise;
		try {
			await h.session.steer("adjust");
		} finally {
			release.resolve();
			await running;
			await h.session.waitForIdle();
		}
		expect(seen).toEqual([
			{ text: "start", source: "interactive", attribution: "user", streamingBehavior: undefined },
			{ text: "adjust", source: "interactive", attribution: "user", streamingBehavior: "steer" },
		]);
	});

	it("attributes RPC steers to the user only when the connection declared interactive_user", async () => {
		const { h, entered, release, seen } = await streamingHarness();
		const running = h.session.prompt("start");
		await entered.promise;
		try {
			await h.session.steer("from a parent agent", undefined, { source: "rpc" });
			await h.session.steer("from the user's client", undefined, { source: "rpc", interactiveUser: true });
		} finally {
			release.resolve();
			await running;
			await h.session.waitForIdle();
		}
		expect(seen.slice(1)).toEqual([
			{ text: "from a parent agent", source: "rpc", attribution: "agent", streamingBehavior: "steer" },
			{ text: "from the user's client", source: "rpc", attribution: "user", streamingBehavior: "steer" },
		]);
	});

	it("attributes a steer an extension sends to an agent", async () => {
		const { h, entered, release, nextInput, extensionApi } = await streamingHarness();
		const running = h.session.prompt("start");
		await entered.promise;
		try {
			const sent = nextInput();
			extensionApi().sendUserMessage("agent steer", { deliverAs: "steer" });
			expect(await sent).toEqual({
				text: "agent steer",
				source: "extension",
				attribution: "agent",
				streamingBehavior: "steer",
			});
		} finally {
			release.resolve();
			await running;
			await h.session.waitForIdle();
		}
	});

	it("attributes a person's answer delivered through the extension API to the user", async () => {
		const { h, entered, release, nextInput, extensionApi } = await streamingHarness();
		const running = h.session.prompt("start");
		await entered.promise;
		try {
			const sent = nextInput();
			deliverAnswer(
				extensionApi(),
				h.session.extensionRunner.createContext(),
				{
					requestId: "answer",
					questions: [{ id: "q", header: "Choice", question: "Choose", options: [], multiSelect: false }],
					waitForAnswer: false,
					timeoutMs: 1000,
				},
				{ status: "answered", answers: { q: { selected: [], text: "yes" } }, unanswered: [] },
				"codex",
			);
			const answer = await sent;
			expect(answer.source).toBe("extension");
			expect(answer.attribution).toBe("user");
		} finally {
			release.resolve();
			await running;
			await h.session.waitForIdle();
		}
	});
});
