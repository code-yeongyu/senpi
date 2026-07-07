import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	createAutoTitleHarness,
	createDeferred,
	waitForCallCount,
	waitForSessionName,
	waitForTitleError,
} from "./agent-session-auto-title-helpers.ts";
import { getAssistantTexts, type Harness } from "./suite/harness.ts";

describe("agent session auto title", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("forks title generation from the first task prompt and applies the suggested session name", async () => {
		const titleResponse = createDeferred<ReturnType<typeof fauxAssistantMessage>>();
		const titleOrTurn: FauxResponseFactory = (context) => {
			const systemPrompt = Array.isArray(context.systemPrompt)
				? context.systemPrompt.join("\n")
				: (context.systemPrompt ?? "");
			if (systemPrompt.includes("<title>")) {
				return titleResponse.promise;
			}
			return fauxAssistantMessage("turn complete");
		};
		const harness = await createAutoTitleHarness();
		harnesses.push(harness);
		harness.setResponses([titleOrTurn, titleOrTurn]);

		const sessionName = waitForSessionName(harness);
		await harness.session.prompt("fix the OAuth login button on mobile");

		expect(getAssistantTexts(harness)).toEqual(["turn complete"]);
		await waitForCallCount(harness, 2);
		expect(harness.faux.getCallLog()[1]?.options).toMatchObject({
			sessionId: harness.session.sessionId,
			cacheRetention: "short",
		});
		expect(harness.faux.getCallLog()[1]?.options).not.toHaveProperty("reasoning");
		expect(harness.sessionManager.getSessionName()).toBeUndefined();

		titleResponse.resolve(fauxAssistantMessage("<title>Fix OAuth Login</title>"));

		await expect(sessionName).resolves.toBe("Fix OAuth Login");
		expect(harness.sessionManager.getSessionName()).toBe("Fix OAuth Login");
	});

	it("keeps the real agent loop ahead of the title request", async () => {
		const titleResponse = createDeferred<ReturnType<typeof fauxAssistantMessage>>();
		const tool: AgentTool = {
			name: "probe",
			label: "Probe",
			description: "Probe ordering",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "tool observed" }], details: {} }),
		};
		const harness = await createAutoTitleHarness({ tools: [tool] });
		harnesses.push(harness);
		harness.session.setActiveToolsByName(["probe"]);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("turn complete after tool"),
			(context) => {
				const systemPrompt = Array.isArray(context.systemPrompt)
					? context.systemPrompt.join("\n")
					: (context.systemPrompt ?? "");
				if (!systemPrompt.includes("<title>")) {
					return fauxAssistantMessage("", { stopReason: "error", errorMessage: "unexpected non-title call" });
				}
				return titleResponse.promise;
			},
		]);

		const sessionName = waitForSessionName(harness);
		await harness.session.prompt("add a probe integration test");

		expect(getAssistantTexts(harness).filter((text) => text.length > 0)).toEqual(["turn complete after tool"]);
		await waitForCallCount(harness, 3);
		expect(harness.faux.getCallLog()[2]?.context.systemPrompt).toContain("<title>");

		titleResponse.resolve(fauxAssistantMessage("<title>Probe Integration Test</title>"));
		await expect(sessionName).resolves.toBe("Probe Integration Test");
	});

	it("defers title generation for low-signal greetings", async () => {
		const harness = await createAutoTitleHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("hi");

		expect(harness.sessionManager.getSessionName()).toBeUndefined();
		expect(getAssistantTexts(harness)).toEqual(["hello"]);
		expect(harness.faux.getCallLog()).toHaveLength(1);
	});

	it("reports title generation errors without blocking the user turn", async () => {
		const harness = await createAutoTitleHarness();
		harnesses.push(harness);
		const titleError = waitForTitleError(harness);
		harness.setResponses([
			fauxAssistantMessage("turn complete"),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "title provider failed" }),
		]);

		await harness.session.prompt("fix the OAuth login button on mobile");

		expect(getAssistantTexts(harness)).toEqual(["turn complete"]);
		await expect(titleError).resolves.toBe("title provider failed");
		expect(harness.sessionManager.getSessionName()).toBeUndefined();
	});

	it("ignores malformed title responses without a title marker", async () => {
		const harness = await createAutoTitleHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("turn complete"), fauxAssistantMessage("Fix OAuth Login")]);

		await harness.session.prompt("fix the OAuth login button on mobile");
		await waitForCallCount(harness, 2);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(harness.sessionManager.getSessionName()).toBeUndefined();
	});

	it("does not overwrite an existing session name", async () => {
		const harness = await createAutoTitleHarness();
		harnesses.push(harness);
		harness.session.setSessionName("Manual Name");
		harness.setResponses([fauxAssistantMessage("turn complete")]);

		await harness.session.prompt("fix the OAuth login button on mobile");

		expect(harness.sessionManager.getSessionName()).toBe("Manual Name");
		expect(harness.faux.getCallLog()).toHaveLength(1);
	});

	it("strips terminal control sequences before persisting generated titles", async () => {
		const harness = await createAutoTitleHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("turn complete"),
			fauxAssistantMessage("<title>Fix\u001b]52;c;Zm9v\u0007 OAuth\u001b[31m Login\u0008</title>"),
		]);

		const sessionName = waitForSessionName(harness);
		await harness.session.prompt("fix the OAuth login button on mobile");

		await expect(sessionName).resolves.toBe("Fix OAuth Login");
		expect(harness.sessionManager.getSessionName()).toBe("Fix OAuth Login");
	});
});
