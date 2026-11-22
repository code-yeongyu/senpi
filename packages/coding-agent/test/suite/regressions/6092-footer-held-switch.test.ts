import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { FooterComponent } from "../../../src/modes/interactive/components/footer.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createFooterData } from "../../helpers/footer-test-fixtures.ts";
import { createHarness, type Harness } from "../harness.ts";

const WIDTH = 200;

function seedLiveContext(harness: Harness, tokens: number): void {
	const timestamp = Date.now();
	const model = harness.getModel();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "large live context ".repeat(30_000) }],
		timestamp: timestamp - 1,
	});
	harness.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "still working" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: {
			input: tokens - 1_000,
			output: 1_000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: tokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

async function createSwitchHarness(): Promise<Harness> {
	return await createHarness({
		models: [
			{ id: "million", contextWindow: 1_000_000, maxTokens: 32_000 },
			{ id: "372k", contextWindow: 372_000, maxTokens: 32_000 },
			{ id: "900k", contextWindow: 900_000, maxTokens: 32_000 },
		],
		settings: { compaction: { keepRecentTokens: 1 } },
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", (event) => ({
					compaction: {
						summary: "compact summary",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				}));
			},
		],
	});
}

function footerText(harness: Harness): string {
	return stripAnsi(new FooterComponent(harness.session, createFooterData(1)).render(WIDTH)[0] ?? "");
}

describe("#6092 footer follows a model switch without waiting for the compaction", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme(undefined, false);
		setKeybindings(new KeybindingsManager());
	});

	afterAll(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("names the held target beside the running model as soon as the switch is held", async () => {
		// given a transcript the target cannot hold yet
		const harness = await createSwitchHarness();
		harnesses.push(harness);
		seedLiveContext(harness, 321_000);
		const target = harness.getModel("372k");
		if (!target) throw new Error("missing held switch fixture");
		expect(footerText(harness)).toMatch(/million$/);

		// when the user picks it
		await harness.session.setModel(target);

		// then the footer says so at once, while the session still runs on the old model
		expect(harness.session.model?.id).toBe("million");
		expect(harness.session.pendingModelSwitch?.model.id).toBe("372k");
		expect(footerText(harness)).toMatch(/million → 372k \(after compact\)$/);
	});

	it("drops the marker and names the target once the next send applies the switch", async () => {
		// given a held switch
		const harness = await createSwitchHarness();
		harnesses.push(harness);
		seedLiveContext(harness, 321_000);
		const target = harness.getModel("372k");
		if (!target) throw new Error("missing applied switch fixture");
		await harness.session.setModel(target);
		harness.setResponses([fauxAssistantMessage("answered on the target model")]);

		// when the next message compacts and the switch lands
		await harness.session.prompt("continue");

		// then the footer names the applied model alone
		expect(harness.session.model?.id).toBe("372k");
		expect(harness.session.pendingModelSwitch).toBeUndefined();
		const plain = footerText(harness);
		expect(plain).toMatch(/372k$/);
		expect(plain).not.toContain("after compact");
	});

	it("names the new model at once when the switch needs no compaction", async () => {
		// given a short conversation
		const harness = await createSwitchHarness();
		harnesses.push(harness);
		const target = harness.getModel("372k");
		if (!target) throw new Error("missing immediate switch fixture");

		// when the user picks a model that fits right now
		await harness.session.setModel(target);

		// then the switch applied and the footer shows only the new model
		expect(harness.session.pendingModelSwitch).toBeUndefined();
		const plain = footerText(harness);
		expect(plain).toMatch(/372k$/);
		expect(plain).not.toContain("after compact");
	});

	it("drops the marker when a later pick supersedes the held switch", async () => {
		// given a held switch
		const harness = await createSwitchHarness();
		harnesses.push(harness);
		seedLiveContext(harness, 321_000);
		const held = harness.getModel("372k");
		const roomy = harness.getModel("900k");
		if (!held || !roomy) throw new Error("missing supersede fixture");
		await harness.session.setModel(held);
		expect(footerText(harness)).toContain("→ 372k (after compact)");

		// when a model that fits right now is chosen afterwards
		await harness.session.setModel(roomy);

		// then the footer follows the pick that stands
		expect(harness.session.pendingModelSwitch).toBeUndefined();
		const plain = footerText(harness);
		expect(plain).toMatch(/900k$/);
		expect(plain).not.toContain("after compact");
	});
});
