import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAnthropicSubscriptionExtension } from "../../../src/core/extensions/builtin/anthropic-subscription/index.ts";
import { buildAnthropicSubscriptionQueryOptions } from "../../../src/core/extensions/builtin/anthropic-subscription/options.ts";
import { loadAnthropicSubscriptionProviderSettingsFromDisk } from "../../../src/core/extensions/builtin/anthropic-subscription/settings.ts";
import { streamAnthropicSubscription } from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";
import { createCompactionLanePolicy } from "../../../src/core/extensions/builtin/compaction/lane-policy.ts";
import { captureSdkRequests, cleanupSdkPaths, sdkPathHarness } from "./2848-sdk-cwd-fixture.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	cleanupSdkPaths();
	vi.unstubAllEnvs();
});

describe("senpi#2848 lane settings cwd", () => {
	it("does not hide a missing compaction-policy cwd as an unreadable settings file", () => {
		const policy = createCompactionLanePolicy({
			loadProviderSettings: () => ({ compactionOwner: "sdk" }),
		});
		expect(() =>
			policy.disablesSenpiCompaction({
				cwd: "",
				model: { provider: "anthropic-subscription" },
			}),
		).toThrow(/session cwd/);
	});
	it("uses project enabled=false for fallback eligibility", async () => {
		const harness = await createHarness({
			extensionFactories: [(pi) => registerAnthropicSubscriptionExtension(pi)],
		});
		harnesses.push(harness);
		mkdirSync(join(harness.tempDir, ".senpi"));
		writeFileSync(
			join(harness.tempDir, ".senpi", "settings.json"),
			JSON.stringify({ anthropicSubscriptionProvider: { enabled: false } }),
		);
		await harness.session.bindExtensions({});

		const eligible = harness.modelRegistry.modelRuntime.isFallbackEligible("anthropic-subscription");

		expect(eligible).toBe(false);
	});

	it("uses project ambient opt-in for OAuth availability", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => registerAnthropicSubscriptionExtension(pi, { readAmbientAuthStatus: async () => true }),
			],
		});
		harnesses.push(harness);
		mkdirSync(join(harness.tempDir, ".senpi"));
		writeFileSync(
			join(harness.tempDir, ".senpi", "settings.json"),
			JSON.stringify({ anthropicSubscriptionProvider: { enabled: true, tokenInjection: "ambient" } }),
		);
		await harness.session.bindExtensions({});

		const models = await harness.modelRegistry.modelRuntime.getAvailable("anthropic-subscription");

		expect(models.length).toBeGreaterThan(0);
	});

	it("rejects missing cwd before submitting an SDK query", async () => {
		const captured = captureSdkRequests();
		const harness = await sdkPathHarness();

		const message = await streamAnthropicSubscription(harness.getModel(), { messages: [] }).result();

		expect(captured).toHaveLength(0);
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("session cwd");
	});

	it("rejects query options with missing or relative session cwd", async () => {
		const harness = await sdkPathHarness();
		for (const cwd of [undefined, "", "relative-project"]) {
			expect(() =>
				buildAnthropicSubscriptionQueryOptions({
					model: harness.getModel(),
					context: { messages: [] },
					cwd,
					providerSettings: {},
				}),
			).toThrow(/session cwd/);
		}
	});

	it("rejects a relative lane-settings cwd instead of reading the host project", () => {
		const root = mkdtempSync(join(tmpdir(), "sdk-settings-cwd-"));
		try {
			vi.stubEnv("SENPI_CODING_AGENT_DIR", root);

			expect(() => loadAnthropicSubscriptionProviderSettingsFromDisk("relative-project")).toThrow(/session cwd/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
