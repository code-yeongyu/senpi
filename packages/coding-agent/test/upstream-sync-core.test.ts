/**
 * Contracts adopted from upstream into the fork's core during the 2026-09-12 upstream sync.
 *
 * Each case pins one adopted behavior at the fork's own seam, because the fork replaced the
 * upstream implementation the original tests targeted:
 *  - per-model compaction token budgets (`compaction.modelOverrides`) resolved by the fork's
 *    compaction settings helpers, including upstream's exact validation errors;
 *  - the agent-level retry delay ceiling (`retry.maxAgentDelayMs`) applied AFTER the fork's
 *    retry-profile planner has computed backoff, hints and jitter;
 *  - `input` extension handlers running for queued input (steer / follow-up) while the fork's
 *    recovery `enqueueOrder` survives;
 *  - extension tools rejected at registration when their parameter schema is not an object.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { CompactionModelOverride } from "../src/core/compaction-settings-access.ts";
import { loadExtensions } from "../src/core/extensions/loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const MODEL = { provider: "faux", id: "faux-1" };
const MODEL_KEY = `${MODEL.provider}/${MODEL.id}`;

describe("upstream sync: core", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	describe("compaction model overrides", () => {
		it("resolves per-model budgets before ordinary settings and defaults", () => {
			const manager = SettingsManager.inMemory({
				compaction: {
					reserveTokens: 100,
					modelOverrides: { [MODEL_KEY]: { reserveTokens: 4096, keepRecentTokens: 512 } },
				},
			});

			expect(manager.getCompactionReserveTokens(MODEL)).toBe(4096);
			expect(manager.getCompactionKeepRecentTokens(MODEL)).toBe(512);
			expect(manager.getCompactionSettings(MODEL)).toMatchObject({
				enabled: true,
				reserveTokens: 4096,
				keepRecentTokens: 512,
			});

			// No model, and a model without an entry, both resolve ordinary setting then default.
			expect(manager.getCompactionReserveTokens()).toBe(100);
			expect(manager.getCompactionKeepRecentTokens()).toBe(20000);
			expect(manager.getCompactionReserveTokens({ provider: MODEL.provider, id: "other" })).toBe(100);
			expect(manager.getCompactionKeepRecentTokens({ provider: "other", id: MODEL.id })).toBe(20000);
		});

		it("keeps the fork's summarization model alongside the resolved budgets", () => {
			const manager = SettingsManager.inMemory({
				compaction: { model: "faux/summarizer", modelOverrides: { [MODEL_KEY]: { reserveTokens: 2048 } } },
			});

			const settings = manager.getCompactionSettings(MODEL);
			expect(settings.model).toBe("faux/summarizer");
			expect(settings.reserveTokens).toBe(2048);
		});

		it("reports invalid override values instead of silently falling back", () => {
			const negative = SettingsManager.inMemory({
				compaction: { modelOverrides: { [MODEL_KEY]: { reserveTokens: -1 } } },
			});
			expect(() => negative.getCompactionSettings(MODEL)).toThrow(
				`Invalid compaction.modelOverrides["${MODEL_KEY}"].reserveTokens setting: -1. Expected a non-negative safe integer.`,
			);
			// The same settings stay usable for a model that has no override entry.
			expect(negative.getCompactionReserveTokens()).toBe(16384);

			const fractional = SettingsManager.inMemory({
				compaction: { modelOverrides: { [MODEL_KEY]: { keepRecentTokens: 1.5 } } },
			});
			expect(() => fractional.getCompactionKeepRecentTokens(MODEL)).toThrow(
				`Invalid compaction.modelOverrides["${MODEL_KEY}"].keepRecentTokens setting: 1.5. Expected a non-negative safe integer.`,
			);

			const notAnObject = SettingsManager.inMemory({
				compaction: { modelOverrides: { [MODEL_KEY]: 42 as unknown as CompactionModelOverride } },
			});
			expect(() => notAnObject.getCompactionSettings(MODEL)).toThrow(
				`Invalid compaction.modelOverrides["${MODEL_KEY}"] setting: 42. Expected an object.`,
			);

			const invalidOrdinary = SettingsManager.inMemory({ compaction: { reserveTokens: -5 } });
			expect(() => invalidOrdinary.getCompactionReserveTokens()).toThrow(
				"Invalid compaction.reserveTokens setting: -5. Expected a non-negative safe integer.",
			);
		});
	});

	describe("agent retry delay cap", () => {
		it("caps the planned retry wait at retry.maxAgentDelayMs", async () => {
			const harness = await createHarness({
				// Pin the planner's jitter sample so the backoff schedule is exact.
				retryRandom: () => 0,
				settings: {
					retry: {
						enabled: true,
						maxRetries: 5,
						baseDelayMs: 1,
						maxAgentDelayMs: 5,
						// Tombstone the shipped "*" lane: a fallback hop would restart the retry budget.
						fallbackChains: { "*": [] },
					},
				},
			});
			harnesses.push(harness);
			const transientError = () =>
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });
			harness.setResponses([
				transientError(),
				transientError(),
				transientError(),
				transientError(),
				fauxAssistantMessage("recovered"),
			]);

			await harness.session.prompt("retry please");

			// 1, 2, 4 come from the profile's exponential backoff; the fourth (8) is cut to the cap.
			expect(harness.eventsOfType("auto_retry_start").map((event) => event.delayMs)).toEqual([1, 2, 4, 5]);
			expect(harness.session.getLastAssistantText()).toBe("recovered");
			expect(harness.getPendingResponseCount()).toBe(0);
		});
	});

	describe("queued input handlers", () => {
		it("runs input handlers for steer and follow-up while preserving enqueueOrder", async () => {
			const observed: Array<{ text: string; source: string; streamingBehavior?: string }> = [];
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("input", (event) => {
							observed.push({
								text: event.text,
								source: event.source,
								streamingBehavior: event.streamingBehavior,
							});
							if (event.text.startsWith("drop")) return { action: "handled" };
							return { action: "transform", text: `handled: ${event.text}` };
						});
					},
				],
			});
			harnesses.push(harness);

			await harness.session.steer("steer me", undefined, { enqueueOrder: 7, source: "rpc" });
			await harness.session.followUp("follow me", undefined, { enqueueOrder: 3, source: "rpc" });
			await harness.session.steer("drop this one", undefined, { source: "rpc" });

			expect(observed).toEqual([
				{ text: "steer me", source: "rpc", streamingBehavior: undefined },
				{ text: "follow me", source: "rpc", streamingBehavior: undefined },
				{ text: "drop this one", source: "rpc", streamingBehavior: undefined },
			]);
			// The handled input never reaches a queue; the other two arrive transformed.
			expect(harness.session.getSteeringMessages()).toEqual(["handled: steer me"]);
			expect(harness.session.getFollowUpMessages()).toEqual(["handled: follow me"]);

			const cleared = harness.session.clearQueue();
			expect(cleared.ordered.map((entry) => ({ text: entry.text, enqueueOrder: entry.enqueueOrder }))).toEqual([
				{ text: "handled: follow me", enqueueOrder: 3 },
				{ text: "handled: steer me", enqueueOrder: 7 },
			]);
		});

		it("defaults the input source to interactive", async () => {
			const sources: string[] = [];
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("input", (event) => {
							sources.push(event.source);
							return undefined;
						});
					},
				],
			});
			harnesses.push(harness);

			await harness.session.steer("no source given");

			expect(sources).toEqual(["interactive"]);
			expect(harness.session.getSteeringMessages()).toEqual(["no source given"]);
		});
	});

	describe("extension tool schema validation", () => {
		it("rejects a tool whose parameter schema is not an object", async () => {
			const dir = mkdtempSync(join(tmpdir(), "upstream-sync-core-"));
			tempDirs.push(dir);
			const extensionPath = join(dir, "array-schema.js");
			writeFileSync(
				extensionPath,
				`export default function(pi) {
	pi.registerTool({
		name: "array_schema",
		label: "Array schema",
		description: "Registers an invalid parameter schema",
		parameters: [],
		execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
	});
}`,
			);

			const result = await loadExtensions([extensionPath], dir);

			expect(result.extensions).toHaveLength(0);
			expect(result.errors).toEqual([
				{
					path: extensionPath,
					error: `Failed to load extension: Tool "array_schema" registered by extension "${extensionPath}" must define an object parameter schema.`,
				},
			]);
		});

		it("keeps registering tools that declare an object schema", async () => {
			const dir = mkdtempSync(join(tmpdir(), "upstream-sync-core-"));
			tempDirs.push(dir);
			const extensionPath = join(dir, "object-schema.js");
			writeFileSync(
				extensionPath,
				`export default function(pi) {
	pi.registerTool({
		name: "object_schema",
		label: "Object schema",
		description: "Registers a valid parameter schema",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
	});
}`,
			);

			const result = await loadExtensions([extensionPath], dir);

			expect(result.errors).toEqual([]);
			expect(result.extensions).toHaveLength(1);
			expect([...result.extensions[0].tools.keys()]).toEqual(["object_schema"]);
		});
	});
});
