// Cursor reports the real context ceiling per conversation checkpoint
// (senpi#1603). The store keeps that observation for the model id and survives
// process restarts, so the next session sizes admission against the truth.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getCursorContextLimit,
	recordCursorContextLimit,
	resetCursorContextLimitStoreForTest,
	resolveCursorContextLimitStorePath,
	resolveCursorContextWindow,
} from "../src/utils/cursor-context-limit.ts";

let storeDir: string;
let storePath: string;
const previousStoreEnv = process.env.CURSOR_CONTEXT_LIMIT_STORE;

beforeEach(() => {
	storeDir = mkdtempSync(join(tmpdir(), "cursor-context-limit-"));
	storePath = join(storeDir, "cursor-context-limits.json");
	process.env.CURSOR_CONTEXT_LIMIT_STORE = storePath;
	resetCursorContextLimitStoreForTest();
});

afterEach(() => {
	resetCursorContextLimitStoreForTest();
	if (previousStoreEnv === undefined) delete process.env.CURSOR_CONTEXT_LIMIT_STORE;
	else process.env.CURSOR_CONTEXT_LIMIT_STORE = previousStoreEnv;
	rmSync(storeDir, { recursive: true, force: true });
});

describe("cursor context limit store", () => {
	it("serves a recorded ceiling to a process that lost its in-memory state", () => {
		// Given: a ceiling observed by an earlier process.
		recordCursorContextLimit("kimi-k3", 200_000);

		// When: in-memory state is dropped the way a restart drops it.
		resetCursorContextLimitStoreForTest();

		// Then: the persisted observation is still the model's ceiling.
		expect(getCursorContextLimit("kimi-k3")).toBe(200_000);
		expect(resolveCursorContextWindow("kimi-k3", 1_048_576)).toBe(200_000);
	});

	it("falls back to the catalog window for a model that was never observed", () => {
		// Given: a store holding another model only.
		recordCursorContextLimit("kimi-k3", 200_000);

		// When/Then: an unobserved model keeps its catalog window.
		expect(getCursorContextLimit("gemini-3.5-flash")).toBeUndefined();
		expect(resolveCursorContextWindow("gemini-3.5-flash", 1_048_576)).toBe(1_048_576);
	});

	it("treats a corrupt store file as empty", () => {
		// Given: a truncated store file.
		writeFileSync(storePath, '{"kimi-k3": 200');

		// When: a fresh read hydrates from it.
		resetCursorContextLimitStoreForTest();

		// Then: nothing is observed and the catalog window wins.
		expect(getCursorContextLimit("kimi-k3")).toBeUndefined();
		expect(resolveCursorContextWindow("kimi-k3", 1_048_576)).toBe(1_048_576);
	});

	it("ignores the non-positive ceilings the first checkpoint of a turn reports", () => {
		// Given/When: the values Cursor sends before it knows the conversation size.
		recordCursorContextLimit("kimi-k3", 0);
		recordCursorContextLimit("kimi-k3", -1);
		recordCursorContextLimit("kimi-k3", Number.NaN);
		recordCursorContextLimit("kimi-k3", undefined);

		// Then: nothing is observed and nothing is persisted.
		expect(getCursorContextLimit("kimi-k3")).toBeUndefined();
		expect(existsSync(storePath)).toBe(false);
	});

	it("persists only when the observed ceiling changes", () => {
		// Given: an already persisted ceiling whose file was removed.
		recordCursorContextLimit("kimi-k3", 200_000);
		rmSync(storePath);

		// When: the same ceiling is observed again.
		recordCursorContextLimit("kimi-k3", 200_000);

		// Then: no rewrite happened; a different ceiling does write.
		expect(existsSync(storePath)).toBe(false);
		recordCursorContextLimit("kimi-k3", 262_144);
		expect(existsSync(storePath)).toBe(true);
		resetCursorContextLimitStoreForTest();
		expect(getCursorContextLimit("kimi-k3")).toBe(262_144);
	});

	it("resolves the store path the way the conversation rotation store does", () => {
		expect(resolveCursorContextLimitStorePath({ CURSOR_CONTEXT_LIMIT_STORE: "/tmp/explicit.json" })).toBe(
			"/tmp/explicit.json",
		);
		expect(
			resolveCursorContextLimitStorePath({ SENPI_CODING_AGENT_DIR: "/tmp/senpi-agent", CODING_AGENT_DIR: "/tmp/x" }),
		).toBe("/tmp/senpi-agent/cursor-context-limits.json");
		expect(resolveCursorContextLimitStorePath({ CODING_AGENT_DIR: "/tmp/legacy-agent/" })).toBe(
			"/tmp/legacy-agent/cursor-context-limits.json",
		);
		expect(resolveCursorContextLimitStorePath({ HOME: "/home/tester" })).toBe(
			"/home/tester/.senpi/agent/cursor-context-limits.json",
		);
	});
});
