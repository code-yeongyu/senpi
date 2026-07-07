import { fauxAssistantMessage, streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	createAutoTitleHarness,
	createDeferred,
	waitForCallCount,
	waitForSessionName,
} from "./agent-session-auto-title-helpers.ts";
import type { Harness } from "./suite/harness.ts";

describe("agent session auto title routing", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("respects models that disable prompt caching", async () => {
		const harness = await createAutoTitleHarness();
		harnesses.push(harness);
		harness.models[0].cacheRetention = "none";
		harness.setResponses([
			fauxAssistantMessage("turn complete"),
			fauxAssistantMessage("<title>Private Task</title>"),
		]);

		const sessionName = waitForSessionName(harness);
		await harness.session.prompt("investigate private account deletion");
		await waitForCallCount(harness, 2);

		expect(harness.faux.getCallLog()[1]?.options).toMatchObject({ cacheRetention: "none" });
		await expect(sessionName).resolves.toBe("Private Task");
	});

	it("runs title generation through the session stream function", async () => {
		const harness = await createAutoTitleHarness();
		harnesses.push(harness);
		harness.session.agent.streamFn = (model, context, options) => {
			const streamOptions = {
				...options,
				serviceTier: "priority",
			};
			return streamSimple({ ...model, id: "upstream-model" }, context, streamOptions);
		};
		harness.setResponses([
			fauxAssistantMessage("turn complete"),
			fauxAssistantMessage("<title>Aliased Priority Task</title>"),
		]);

		const sessionName = waitForSessionName(harness);
		await harness.session.prompt("fix the OAuth login button on mobile");
		await waitForCallCount(harness, 2);

		expect(harness.faux.getCallLog()[1]?.modelId).toBe("upstream-model");
		expect(harness.faux.getCallLog()[1]?.options).toMatchObject({
			serviceTier: "priority",
			sessionId: harness.session.sessionId,
			cacheRetention: "short",
		});
		await expect(sessionName).resolves.toBe("Aliased Priority Task");
	});

	it("forwards provider request hooks to title generation", async () => {
		const onPayloadCalls: string[] = [];
		const harness = await createAutoTitleHarness({
			onPayload: (payload) => {
				onPayloadCalls.push(JSON.stringify(payload));
			},
		});
		harnesses.push(harness);
		harness.session.agent.streamFn = async (model, context, options) => {
			await options?.onPayload?.({ systemPrompt: context.systemPrompt, messages: context.messages }, model);
			return streamSimple(model, context, options);
		};
		harness.setResponses([
			fauxAssistantMessage("turn complete"),
			fauxAssistantMessage("<title>Hooked Title</title>"),
		]);

		const sessionName = waitForSessionName(harness);
		await harness.session.prompt("fix the OAuth login button on mobile");
		await waitForCallCount(harness, 2);

		expect(harness.faux.getCallLog()[1]?.options?.onPayload).toBeTypeOf("function");
		expect(onPayloadCalls).toHaveLength(2);
		expect(onPayloadCalls[1]).toContain("Generate a concise title");
		await expect(sessionName).resolves.toBe("Hooked Title");
	});

	it("uses the submitted prompt instead of extension-expanded text for title generation", async () => {
		const harness = await createAutoTitleHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", (event) => ({
						action: "transform",
						text: `${event.text}\nPRIVATE EXPANDED CONTEXT`,
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("turn complete"),
			fauxAssistantMessage("<title>OAuth Mobile Login</title>"),
		]);

		const sessionName = waitForSessionName(harness);
		await harness.session.prompt("fix the OAuth login button on mobile");
		await waitForCallCount(harness, 2);

		expect(JSON.stringify(harness.faux.getCallLog()[0]?.context.messages ?? [])).toContain(
			"PRIVATE EXPANDED CONTEXT",
		);
		const titleMessages = JSON.stringify(harness.faux.getCallLog()[1]?.context.messages ?? []);
		expect(titleMessages).toContain("fix the OAuth login button on mobile");
		expect(titleMessages).not.toContain("PRIVATE EXPANDED CONTEXT");
		await expect(sessionName).resolves.toBe("OAuth Mobile Login");
	});

	it("does not title extension-originated user messages", async () => {
		const harness = await createAutoTitleHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("turn complete"),
			fauxAssistantMessage("<title>Extension Private Prompt</title>"),
		]);

		await harness.session.sendUserMessage("PRIVATE EXTENSION PROMPT");
		await harness.session.waitForSettledSessionWork();

		expect(harness.faux.getCallLog()).toHaveLength(1);
		expect(harness.sessionManager.getSessionName()).toBeUndefined();
	});

	it("does not stack title requests while one is already running", async () => {
		const titleResponse = createDeferred<ReturnType<typeof fauxAssistantMessage>>();
		const harness = await createAutoTitleHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first turn complete"),
			() => titleResponse.promise,
			fauxAssistantMessage("second turn complete"),
		]);

		const sessionName = waitForSessionName(harness);
		await harness.session.prompt("fix the OAuth login button on mobile");
		await waitForCallCount(harness, 2);
		await harness.session.prompt("add keyboard navigation for the login form");

		expect(harness.faux.getCallLog()).toHaveLength(3);
		titleResponse.resolve(fauxAssistantMessage("<title>OAuth Mobile Login</title>"));
		await expect(sessionName).resolves.toBe("OAuth Mobile Login");
	});
});
