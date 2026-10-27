import { fauxAssistantMessage, getCurrentSystemPrompt, getInitialSystemMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildSystemPromptOptions, ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";

const STABLE_BLOCK = "<stable-block>same in every session</stable-block>";
const MEMORY_BLOCK = "<memory-block>revision 7</memory-block>";
const LATE_STABLE_BLOCK = "<late-stable-block>after memory</late-stable-block>";

const stableExtension: ExtensionFactory = (pi) => {
	pi.on(
		"before_agent_start",
		(event) => ({ systemPrompt: `${event.systemPrompt}\n\n${STABLE_BLOCK}`, systemPromptCache: "stable" }),
		{ previewSafe: true },
	);
};

const memoryExtension: ExtensionFactory = (pi) => {
	pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${MEMORY_BLOCK}` }), {
		previewSafe: true,
	});
};

const lateStableExtension: ExtensionFactory = (pi) => {
	pi.on(
		"before_agent_start",
		(event) => ({ systemPrompt: `${event.systemPrompt}\n\n${LATE_STABLE_BLOCK}`, systemPromptCache: "stable" }),
		{ previewSafe: true },
	);
};

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function harnessWith(extensionFactories: ExtensionFactory[]): Promise<Harness> {
	const harness = await createHarness({ extensionFactories });
	harnesses.push(harness);
	return harness;
}

async function firstRequestSystem(harness: Harness): Promise<{ prompt: string; stablePrefixLength?: number }> {
	let captured: { prompt: string; stablePrefixLength?: number } = { prompt: "" };
	harness.setResponses([
		(context) => {
			const stablePrefixLength = getInitialSystemMessage(context.messages)?.stablePrefixLength;
			captured = {
				prompt: getCurrentSystemPrompt(context.messages),
				...(stablePrefixLength === undefined ? {} : { stablePrefixLength }),
			};
			return fauxAssistantMessage("done");
		},
	]);
	await harness.session.prompt("hello");
	return captured;
}

describe("system prompt stable prefix reaches the provider request (senpi#4447)", () => {
	it("ends the stable prefix where the first volatile extension addition starts", async () => {
		const harness = await harnessWith([stableExtension, memoryExtension]);

		const { prompt, stablePrefixLength } = await firstRequestSystem(harness);

		expect(prompt.slice(0, stablePrefixLength).endsWith(STABLE_BLOCK)).toBe(true);
		expect(prompt.slice(stablePrefixLength ?? 0)).toBe(`\n\n${MEMORY_BLOCK}`);
	});

	it("keeps a stable addition that lands after a volatile one behind the boundary", async () => {
		const harness = await harnessWith([stableExtension, memoryExtension, lateStableExtension]);

		const { prompt, stablePrefixLength } = await firstRequestSystem(harness);

		expect(prompt.slice(stablePrefixLength ?? 0)).toBe(`\n\n${MEMORY_BLOCK}\n\n${LATE_STABLE_BLOCK}`);
	});

	it("sends no split when every addition is stable", async () => {
		const harness = await harnessWith([stableExtension]);

		const { stablePrefixLength } = await firstRequestSystem(harness);

		expect(stablePrefixLength).toBeUndefined();
	});

	it("computes the same prefix in a preview composition (prompt-cache prewarm)", async () => {
		const harness = await harnessWith([stableExtension, memoryExtension]);

		const result = await harness
			.getExtensionRunner()
			.emitBeforeAgentStart("", undefined, "BASE", { cwd: process.cwd() } as BuildSystemPromptOptions, {
				preview: true,
			});

		expect(result?.systemPromptStablePrefix).toBe(`BASE\n\n${STABLE_BLOCK}`);
	});
});
