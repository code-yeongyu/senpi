import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

// Read boundary (j) of senpi#1989: Settings.providers is keyed by provider id.
// A settings.json written by an earlier version keys it by the LEGACY id, and
// migrateSettings does not rewrite that block, so the accessor must read it.
const dirs: string[] = [];
function dir(): string {
	const d = mkdtempSync(join(tmpdir(), "t8-providers-"));
	dirs.push(d);
	return d;
}
function writeGlobal(agent: string, settings: unknown): void {
	mkdirSync(agent, { recursive: true });
	writeFileSync(join(agent, "settings.json"), JSON.stringify(settings, null, 2));
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("read boundary: Settings.providers concurrency (senpi#1989)", () => {
	it("resolves a limit written under the legacy provider id", () => {
		const agent = dir();
		writeGlobal(agent, { providers: { "claude-sdk-oauth": { maxConcurrency: 3 } } });
		const m = SettingsManager.create(dir(), agent);
		// the user configured this limit before the rename; it must not detach
		expect(m.getProviderConcurrencyLimit("anthropic-subscription")).toBe(3);
	});

	it("resolves a limit written under the canonical id", () => {
		const agent = dir();
		writeGlobal(agent, { providers: { "anthropic-subscription": { maxConcurrency: 5 } } });
		expect(SettingsManager.create(dir(), agent).getProviderConcurrencyLimit("anthropic-subscription")).toBe(5);
	});

	it("prefers the canonical entry when both are present", () => {
		const agent = dir();
		writeGlobal(agent, {
			providers: { "anthropic-subscription": { maxConcurrency: 7 }, "claude-sdk-oauth": { maxConcurrency: 2 } },
		});
		expect(SettingsManager.create(dir(), agent).getProviderConcurrencyLimit("anthropic-subscription")).toBe(7);
	});

	it("leaves the untouched API-key provider resolving exactly", () => {
		const agent = dir();
		writeGlobal(agent, { providers: { anthropic: { maxConcurrency: 4 } } });
		const m = SettingsManager.create(dir(), agent);
		expect(m.getProviderConcurrencyLimit("anthropic")).toBe(4);
		// the subscription lane must NOT inherit the API-key lane's limit
		expect(m.getProviderConcurrencyLimit("anthropic-subscription")).toBe(Number.POSITIVE_INFINITY);
	});

	it("returns Infinity when nothing is configured", () => {
		const agent = dir();
		writeGlobal(agent, {});
		expect(SettingsManager.create(dir(), agent).getProviderConcurrencyLimit("anthropic-subscription")).toBe(
			Number.POSITIVE_INFINITY,
		);
	});
});
