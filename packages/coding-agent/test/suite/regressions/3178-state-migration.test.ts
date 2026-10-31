import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsManager, type SettingsStorage } from "../../../src/core/settings-manager.ts";

describe("3178 migration publication and no-op saves", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("writes state before removing legacy config and resumes an interrupted rewrite", () => {
		let global = '{"theme":"dark","tipsHistory":{"example":123}}';
		let state: string | undefined;
		let failRewrite = true;
		const publications: string[] = [];
		const storage: SettingsStorage = {
			withLock: (scope, fn) => {
				const next = fn(scope === "global" ? global : undefined);
				if (next === undefined || scope !== "global") return;
				publications.push("config");
				if (failRewrite) throw new Error("synthetic config publish failure");
				global = next;
			},
			withStateLock: (fn) => {
				const next = fn(state);
				if (next === undefined) return;
				publications.push("state");
				state = next;
			},
		};

		const interrupted = SettingsManager.fromStorage(storage);
		expect(publications).toEqual(["state", "config"]);
		expect(interrupted.getTipsHistory()).toEqual({ example: 123 });
		expect(JSON.parse(global).tipsHistory).toEqual({ example: 123 });
		const publishedState = state;
		failRewrite = false;
		// A failed migration is retried on a fresh launch, not by every manager in this process.
		SettingsManager.fromStorage({ ...storage });
		expect(state).toBe(publishedState);
		expect(JSON.parse(global)).toEqual({ theme: "dark" });
		const publishedConfig = global;
		SettingsManager.fromStorage({ ...storage });
		expect(global).toBe(publishedConfig);
		expect(publications).toEqual(["state", "config", "config"]);
	});

	it("migrates JSONC state without normalizing unrelated raw legacy config", () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-3178-jsonc-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		mkdirSync(agentDir);
		const configPath = join(agentDir, "settings.jsonc");
		writeFileSync(
			configPath,
			'{ // comment\n"queueMode":"all","tipsHistory":{"example":123},"defaultProvider":"openai-codex",}',
		);

		SettingsManager.create(root, agentDir);
		expect(readFileSync(configPath, "utf8")).toBe(
			JSON.stringify(
				{
					queueMode: "all",
					defaultProvider: "openai-codex",
				},
				null,
				2,
			),
		);
		expect(JSON.parse(readFileSync(join(agentDir, "state.json"), "utf8"))).toEqual({ tipsHistory: { example: 123 } });
	});

	it("preserves no-op JSONC saves, reordered objects, missing keys and legacy shapes", async () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-3178-noop-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		mkdirSync(agentDir);
		const path = join(agentDir, "settings.jsonc");
		const original =
			'{ // keep me\n"theme":"dark","queueMode":"all","warnings":{"offRecommendedModel":false,"anthropicExtraUsage":true},}';
		writeFileSync(path, original);
		const manager = SettingsManager.create(root, agentDir);

		manager.setTheme("dark");
		manager.setWarnings({ anthropicExtraUsage: true, offRecommendedModel: false });
		manager.setFavoriteModels(undefined);
		await manager.flush();
		expect(manager.drainErrors()).toEqual([]);
		expect(readFileSync(path, "utf8")).toBe(original);
	});
});
