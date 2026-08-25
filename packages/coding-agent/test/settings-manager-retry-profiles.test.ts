import { describe, expect, it } from "vitest";
import { validateRetryProviderOverrides } from "../src/core/retry-fallback/profile-override.ts";

const KNOWN = new Set(["anthropic", "kimi-coding", "openai"]);

describe("validateRetryProviderOverrides", () => {
	it("returns a valid entry for a known provider intact with zero warnings", () => {
		const { overrides, warnings } = validateRetryProviderOverrides(
			{
				"kimi-coding": {
					turn: { maxRetries: 4, baseDelayMs: 1000, growthFactor: 2, perAttemptCapMs: null },
				},
			},
			KNOWN,
		);

		expect(warnings).toEqual([]);
		expect(overrides["kimi-coding"]?.turn?.maxRetries).toBe(4);
		expect(overrides["kimi-coding"]?.turn?.perAttemptCapMs).toBeNull();
	});

	it("rejects the ENTIRE provider entry when any knob is invalid (atomic rejection)", () => {
		const { overrides, warnings } = validateRetryProviderOverrides(
			{
				anthropic: {
					turn: { maxRetries: -1, baseDelayMs: 500 },
				},
			},
			KNOWN,
		);

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("anthropic");
		expect(warnings[0]).toContain("maxRetries");
		expect(overrides.anthropic).toBeUndefined();
	});

	it("warns once and drops an unknown provider id", () => {
		const { overrides, warnings } = validateRetryProviderOverrides(
			{ "not-a-provider": { turn: { maxRetries: 5 } } },
			KNOWN,
		);

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("unknown provider id");
		expect(overrides["not-a-provider"]).toBeUndefined();
	});

	it("rejects serverHintMaxDelayMs for a tiered-stage provider", () => {
		const { overrides, warnings } = validateRetryProviderOverrides(
			{ openai: { turn: { serverHintMaxDelayMs: 30_000 } } },
			KNOWN,
			new Set(["openai"]),
		);

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("tiered");
		expect(overrides.openai).toBeUndefined();
	});

	it("returns one warning and an empty map for a non-object value", () => {
		const { overrides, warnings } = validateRetryProviderOverrides("not-an-object", KNOWN);

		expect(warnings).toHaveLength(1);
		expect(Object.keys(overrides)).toHaveLength(0);
	});
});

import { join } from "node:path";
import { KIMI_CODE_RETRY_PROFILE } from "@earendil-works/pi-ai/utils/retry-profile/profiles";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import {
	afterEach as afterEachCleanup,
	describe as describeProfile,
	expect as expectProfile,
	it as itProfile,
} from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const profileTempDirs: string[] = [];

function createProfilePaths(): { agentDir: string; projectDir: string } {
	const root = mkdtempSync(join(tmpdir(), "senpi-retry-profile-"));
	profileTempDirs.push(root);
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
	return { agentDir, projectDir };
}

afterEachCleanup(() => {
	for (const dir of profileTempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describeProfile("resolveRetryProfile precedence", () => {
	itProfile(
		"kimi-declared provider resolves 9/500/additive/32000/null-ceiling; anthropic resolves 3/2000/additive/8000-cap",
		() => {
			const { agentDir, projectDir } = createProfilePaths();
			const manager = SettingsManager.create(projectDir, agentDir);

			const kimi = manager.resolveRetryProfile({ id: "kimi-coding", retryPolicy: KIMI_CODE_RETRY_PROFILE });
			expectProfile(kimi.turn.maxRetries).toBe(9);
			expectProfile(kimi.turn.backoff.baseDelayMs).toBe(500);
			expectProfile(kimi.turn.backoff.jitter).toEqual({ mode: "additive", ratio: 0.25 });
			expectProfile(kimi.turn.backoff.perAttemptCapMs).toBe(32_000);

			const anthropic = manager.resolveRetryProfile({ id: "anthropic" });
			expectProfile(anthropic.turn.maxRetries).toBe(3);
			expectProfile(anthropic.turn.backoff.baseDelayMs).toBe(2000);
			// Phase-2 default policy: locally computed turn backoff gained +0..25%
			// additive jitter and an 8s per-attempt cap (see profiles.ts senpi-default).
			expectProfile(anthropic.turn.backoff.jitter).toEqual({ mode: "additive", ratio: 0.25 });
			expectProfile(anthropic.turn.backoff.perAttemptCapMs).toBe(8_000);
		},
	);

	itProfile("user global retry.maxRetries changes anthropic but NOT kimi", () => {
		const { agentDir, projectDir } = createProfilePaths();
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { maxRetries: 7 } }));
		const manager = SettingsManager.create(projectDir, agentDir);

		const anthropic = manager.resolveRetryProfile({ id: "anthropic" });
		expectProfile(anthropic.turn.maxRetries).toBe(7);

		const kimi = manager.resolveRetryProfile({ id: "kimi-coding", retryPolicy: KIMI_CODE_RETRY_PROFILE });
		expectProfile(kimi.turn.maxRetries).toBe(9);
	});

	itProfile("retry.providers override changes only that provider", () => {
		const { agentDir, projectDir } = createProfilePaths();
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ retry: { providers: { "kimi-coding": { turn: { maxRetries: 4 } } } } }),
		);
		const manager = SettingsManager.create(projectDir, agentDir);

		const kimi = manager.resolveRetryProfile({ id: "kimi-coding", retryPolicy: KIMI_CODE_RETRY_PROFILE });
		expectProfile(kimi.turn.maxRetries).toBe(4);

		const anthropic = manager.resolveRetryProfile({ id: "anthropic" });
		expectProfile(anthropic.turn.maxRetries).toBe(3);
	});

	itProfile("retry.enabled false forces turn.enabled false on both", () => {
		const { agentDir, projectDir } = createProfilePaths();
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
		const manager = SettingsManager.create(projectDir, agentDir);

		const kimi = manager.resolveRetryProfile({ id: "kimi-coding", retryPolicy: KIMI_CODE_RETRY_PROFILE });
		expectProfile(kimi.turn.enabled).toBe(false);

		const anthropic = manager.resolveRetryProfile({ id: "anthropic" });
		expectProfile(anthropic.turn.enabled).toBe(false);
	});

	itProfile("invalid override leaves the resolution equal to un-overridden", () => {
		const { agentDir, projectDir } = createProfilePaths();
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ retry: { providers: { "kimi-coding": { turn: { maxRetries: -1 } } } } }),
		);
		const manager = SettingsManager.create(projectDir, agentDir);

		const kimi = manager.resolveRetryProfile({ id: "kimi-coding", retryPolicy: KIMI_CODE_RETRY_PROFILE });
		expectProfile(kimi.turn.maxRetries).toBe(9);
		expectProfile(kimi.turn.backoff.baseDelayMs).toBe(500);
	});
});
