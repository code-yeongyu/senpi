import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { PromptOptions } from "../../../src/core/agent-session.ts";
import { createHarness, type Harness } from "../harness.ts";

// A usage limit with no reset hint: the session's hold on the account is a guessed default (30 min).
const guessedLimit = "usage_limit_reached: the usage limit has been reached";
const epoch = Date.UTC(2026, 10, 2, 12);
const statedLimit = (resetsAtMs: number) =>
	`429 {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_at":${resetsAtMs / 1000}}}`;

describe("#5568 a person's turn re-probes a guessed usage-limit hold", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.cleanup();
	});

	async function spentSession(errorMessage: string): Promise<{ harness: Harness; tick: (ms: number) => void }> {
		let now = 0;
		const harness = await createHarness({
			fallbackNow: () => now,
			fallbackWallNow: () => epoch + now,
			settings: { retry: { enabled: true }, compaction: { enabled: false } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage })]);
		await harness.session.prompt("first attempt");
		expect(harness.faux.getCallLog()).toHaveLength(1);
		return { harness, tick: (ms) => (now += ms) };
	}

	it.each<{ name: string; options: PromptOptions }>([
		{ name: "TUI input", options: {} },
		{ name: "RPC input from an interactive user", options: { source: "rpc", interactiveUser: true } },
	])("sends one request for $name instead of refusing from the guessed hold", async ({ options }) => {
		const { harness, tick } = await spentSession(guessedLimit);
		tick(60_000);
		harness.setResponses([fauxAssistantMessage("the account serves again")]);

		await harness.session.prompt("continue", options);

		expect(harness.faux.getCallLog()).toHaveLength(2);
		expect(harness.session.messages.at(-1)).toMatchObject({
			content: [expect.objectContaining({ text: "the account serves again" })],
		});
	});

	it("lets automated turns through once a person's probe was served", async () => {
		const { harness, tick } = await spentSession(guessedLimit);
		tick(60_000);
		harness.setResponses([fauxAssistantMessage("served"), fauxAssistantMessage("automated turn served")]);

		await harness.session.prompt("continue");
		await harness.session.prompt("goal continuation", { source: "extension" });

		expect(harness.faux.getCallLog()).toHaveLength(3);
	});

	it.each<{ name: string; options: PromptOptions }>([
		{ name: "an extension turn", options: { source: "extension" } },
		{ name: "RPC input from an agent client", options: { source: "rpc" } },
	])("still refuses $name from the guessed hold without a request (#3131)", async ({ options }) => {
		const { harness, tick } = await spentSession(guessedLimit);
		tick(60_000);

		await expect(harness.session.prompt("continue", options)).rejects.toMatchObject({
			name: "AccountUsageLimitError",
		});
		expect(harness.faux.getCallLog()).toHaveLength(1);
	});

	it("keeps a reset the provider stated, and the refusal names it", async () => {
		const resetsAt = epoch + 2 * 60 * 60_000;
		const { harness, tick } = await spentSession(statedLimit(resetsAt));
		tick(60_000);

		const refusal = harness.session.prompt("continue");

		await expect(refusal).rejects.toMatchObject({ name: "AccountUsageLimitError" });
		await expect(refusal).rejects.toThrow(/\(resets [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}\s?[AP]M/);
		expect(harness.faux.getCallLog()).toHaveLength(1);
	});

	it("names a retry-after the provider stated when the error text carries no reset", async () => {
		let now = 0;
		const harness = await createHarness({
			fallbackNow: () => now,
			fallbackWallNow: () => epoch + now,
			settings: { retry: { enabled: true }, compaction: { enabled: false } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: `${guessedLimit} (retry-after-ms: ${3 * 60 * 60_000})`,
			}),
		]);
		await harness.session.prompt("first attempt");
		now += 60_000;

		const refusal = harness.session.prompt("continue");

		await expect(refusal).rejects.toThrow(/\(resets [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}\s?[AP]M/);
		expect(harness.faux.getCallLog()).toHaveLength(1);
	});
});
