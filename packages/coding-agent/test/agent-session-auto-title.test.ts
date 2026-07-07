import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxToolCall,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, type Harness, type HarnessOptions } from "./suite/harness.ts";

interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function waitForSessionName(harness: Harness): Promise<string | undefined> {
	return new Promise((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type !== "session_info_changed") {
				return;
			}
			unsubscribe();
			resolve(event.name);
		});
	});
}

function createAutoTitleHarness(options: HarnessOptions = {}): Promise<Harness> {
	return createHarness({ ...options, persistSession: true, autoTitleSessions: true });
}

function waitForTitleError(harness: Harness): Promise<string> {
	return new Promise((resolve) => {
		harness.session.extensionRunner.onError((error) => {
			if (error.event === "session_title_generation") {
				resolve(error.error);
			}
		});
	});
}

async function waitForCallCount(harness: Harness, expected: number): Promise<void> {
	const startedAt = Date.now();
	while (harness.faux.getCallLog().length < expected) {
		if (Date.now() - startedAt > 2_000) {
			throw new Error(`Timed out waiting for ${expected} faux calls`);
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

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

		expect(getAssistantTexts(harness)).toEqual(["first turn complete", "second turn complete"]);
		expect(harness.faux.getCallLog()).toHaveLength(3);

		titleResponse.resolve(fauxAssistantMessage("<title>OAuth Mobile Login</title>"));
		await expect(sessionName).resolves.toBe("OAuth Mobile Login");
		expect(harness.faux.getCallLog()).toHaveLength(3);
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
