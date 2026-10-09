import { Agent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";

const COMPACTION_ERROR = "Context remains above the compaction threshold";

/** The model a session runs on when no provider is configured: the agent's own default state. */
const NO_PROVIDER_PLACEHOLDER = new Agent({ streamFn: streamSimple }).state.model;

describe("a first run with no provider configured", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function firstRunSession(): Promise<Harness> {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		harness.session.agent.state.model = NO_PROVIDER_PLACEHOLDER;
		return harness;
	}

	it("#given no provider #when the user sends a message #then the error says no provider, not that compaction failed", async () => {
		// given
		const harness = await firstRunSession();

		// when
		const outcome = harness.session.prompt("hello").then(
			() => "accepted",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);

		// then
		const message = await outcome;
		expect(message).not.toContain(COMPACTION_ERROR);
		expect(message).toContain("/login");
		expect(harness.faux.getCallLog()).toEqual([]);
	});

	it("#given no provider #when an extension triggers a turn #then it fails with the no-provider guidance, not a compaction error", async () => {
		// given
		const harness = await firstRunSession();

		// when
		const outcome = harness.session
			.sendCustomMessage({ customType: "startup-note", content: "ready", display: false }, { triggerTurn: true })
			.then(
				() => "accepted",
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			);

		// then
		const message = await outcome;
		expect(message).not.toContain(COMPACTION_ERROR);
		expect(message).toContain("/login");
		expect(harness.faux.getCallLog()).toEqual([]);
	});

	it("#given a model whose context window is unknown #when a turn is admitted #then it is not treated as over the compaction threshold", async () => {
		// given
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.state.model = { ...harness.getModel(), contextWindow: 0 };
		harness.setResponses([]);

		// when
		const outcome = harness.session
			.sendCustomMessage({ customType: "startup-note", content: "ready", display: false }, { triggerTurn: true })
			.then(
				() => "accepted",
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			);

		// then
		expect(await outcome).not.toContain(COMPACTION_ERROR);
	});

	it("#given no provider #when a startup extension triggers turns twice #then the user sees the /login guidance once and no extension error", async () => {
		// given
		let api: ExtensionAPI | undefined;
		const harness = await createHarness({
			withConfiguredAuth: false,
			extensionFactories: [
				(pi) => {
					api = pi;
				},
			],
		});
		harnesses.push(harness);
		harness.session.agent.state.model = NO_PROVIDER_PLACEHOLDER;
		const extensionErrors: string[] = [];
		harness.getExtensionRunner().onError((error) => extensionErrors.push(error.error));
		const typedPromptGuidance = await harness.session.prompt("hello").then(
			() => "accepted",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);

		// when
		api?.sendMessage({ customType: "startup-note", content: "ready", display: false }, { triggerTurn: true });
		api?.sendMessage({ customType: "startup-note", content: "again", display: false }, { triggerTurn: true });
		await harness.session.waitForSettledSessionWork();

		// then
		expect(extensionErrors).toEqual([]);
		expect(harness.eventsOfType("provider_required").map((event) => event.notice)).toEqual([typedPromptGuidance]);
		expect(harness.faux.getCallLog()).toEqual([]);
	});

	it("#given no provider #when an extension sends a user message #then it gets the same one notice, not an extension error", async () => {
		// given
		let api: ExtensionAPI | undefined;
		const harness = await createHarness({
			withConfiguredAuth: false,
			extensionFactories: [
				(pi) => {
					api = pi;
				},
			],
		});
		harnesses.push(harness);
		harness.session.agent.state.model = NO_PROVIDER_PLACEHOLDER;
		const extensionErrors: string[] = [];
		const outcome = new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("no outcome within 10s")), 10_000);
			harness.getExtensionRunner().onError((error) => {
				extensionErrors.push(error.error);
				clearTimeout(timer);
				resolve("extension-error");
			});
			harness.session.subscribe((event) => {
				if (event.type !== "provider_required") return;
				clearTimeout(timer);
				resolve("provider-required");
			});
		});

		// when
		api?.sendUserMessage("continue the plan");

		// then
		expect(await outcome).toBe("provider-required");
		expect(extensionErrors).toEqual([]);
		expect(harness.eventsOfType("provider_required")).toHaveLength(1);
		expect(harness.eventsOfType("provider_required")[0]?.notice).toContain("/login");
		expect(harness.faux.getCallLog()).toEqual([]);
	});

	it("#given the notice was shown #when a turn is admitted and the provider is lost again #then the user is told again", async () => {
		// given
		let api: ExtensionAPI | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					api = pi;
				},
			],
		});
		harnesses.push(harness);
		const workingModel = harness.getModel();
		harness.setResponses([fauxAssistantMessage("answered")]);
		harness.session.agent.state.model = NO_PROVIDER_PLACEHOLDER;
		api?.sendMessage({ customType: "note", content: "first", display: false }, { triggerTurn: true });
		await harness.session.waitForSettledSessionWork();

		// when
		harness.session.agent.state.model = workingModel;
		await harness.session.prompt("hello");
		harness.session.agent.state.model = NO_PROVIDER_PLACEHOLDER;
		api?.sendMessage({ customType: "note", content: "second", display: false }, { triggerTurn: true });
		await harness.session.waitForSettledSessionWork();

		// then
		expect(harness.eventsOfType("provider_required")).toHaveLength(2);
		expect(harness.faux.getCallLog()).toHaveLength(1);
	});
});
