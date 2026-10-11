import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelBlacklistPolicy, ModelBlacklistStore } from "../src/core/model-blacklist.ts";

let directory: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "model-blacklist-"));
});
afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

const file = () => join(directory, "model-blacklist.json");
const save = (models: unknown) => writeFileSync(file(), JSON.stringify({ models }));
const savedRules = () => (JSON.parse(readFileSync(file(), "utf8")) as { models: string[] }).models;
const model = (provider: string, id: string) => ({ provider, id });

describe("ModelBlacklistPolicy", () => {
	it("blocks nothing without rules", () => {
		expect(ModelBlacklistPolicy.empty().isBlocked(model("openai", "gpt-5"))).toBe(false);
	});

	it("lets the last matching rule decide, with ! exceptions", () => {
		const policy = ModelBlacklistPolicy.fromRules([
			"anthropic/*",
			"!anthropic/claude-sonnet-*",
			"anthropic/claude-sonnet-3*",
		]);
		expect(policy.decide(model("anthropic", "claude-opus-4"))).toEqual({ blocked: true, rule: "anthropic/*" });
		expect(policy.decide(model("anthropic", "claude-sonnet-4"))).toEqual({
			blocked: false,
			rule: "!anthropic/claude-sonnet-*",
		});
		expect(policy.isBlocked(model("anthropic", "claude-sonnet-3-7"))).toBe(true);
		expect(policy.isBlocked(model("openai", "gpt-5"))).toBe(false);
	});

	it("matches ? as one character, * across slashes, and \\ as an escape", () => {
		const policy = ModelBlacklistPolicy.fromRules(["a/m?", "openrouter/*/free", "b/literal\\*star"]);
		expect(policy.isBlocked(model("a", "m1"))).toBe(true);
		expect(policy.isBlocked(model("a", "m12"))).toBe(false);
		expect(policy.isBlocked(model("openrouter", "vendor/model/free"))).toBe(true);
		expect(policy.isBlocked(model("b", "literal*star"))).toBe(true);
		expect(policy.isBlocked(model("b", "literalXstar"))).toBe(false);
	});

	it.each([
		["invalid JSON", "{nope"],
		["a non-object", "[]"],
		["missing models", "{}"],
		["rules that are not an array", JSON.stringify({ models: "x/*" })],
		["a non-string rule", JSON.stringify({ models: [1] })],
		["a bare ! rule", JSON.stringify({ models: ["!"] })],
	])("fails closed on %s", (_label, text) => {
		const policy = ModelBlacklistPolicy.parse(text);
		expect(policy.error).toBeDefined();
		expect(policy.isBlocked(model("any", "model"))).toBe(true);
		expect(() => policy.toggledRules(model("any", "model"))).toThrow(/malformed/);
	});

	it("adds the minimal exact rule under wildcards and removes it again", () => {
		const blockAll = ModelBlacklistPolicy.fromRules(["bl/*"]);
		const unblocked = blockAll.toggledRules(model("bl", "alpha"));
		expect(unblocked).toEqual(["bl/*", "!bl/alpha"]);
		expect(ModelBlacklistPolicy.fromRules(unblocked).toggledRules(model("bl", "alpha"))).toEqual(["bl/*"]);

		const blocked = ModelBlacklistPolicy.empty().toggledRules(model("bl", "a*b"));
		expect(blocked).toEqual(["bl/a\\*b"]);
		expect(ModelBlacklistPolicy.fromRules(blocked).isBlocked(model("bl", "a*b"))).toBe(true);
		expect(ModelBlacklistPolicy.fromRules(blocked).isBlocked(model("bl", "aXb"))).toBe(false);
	});

	it("keeps a later wildcard from undoing a toggle", () => {
		const rules = ModelBlacklistPolicy.fromRules(["bl/*", "!bl/alpha", "bl/al*"]).toggledRules(model("bl", "alpha"));
		expect(ModelBlacklistPolicy.fromRules(rules).isBlocked(model("bl", "alpha"))).toBe(false);
	});
});

describe("ModelBlacklistStore", () => {
	it("treats a missing file as an empty policy", () => {
		const store = new ModelBlacklistStore(file());
		expect(store.active.isEmpty).toBe(true);
		expect(store.saved().isBlocked(model("bl", "alpha"))).toBe(false);
	});

	it("fails closed on a malformed saved file and refuses to overwrite it", async () => {
		writeFileSync(file(), "{broken");
		const store = new ModelBlacklistStore(file());
		expect(store.active.error).toContain("model-blacklist.json");
		expect(store.active.isBlocked(model("bl", "alpha"))).toBe(true);
		await expect(store.toggle(model("bl", "alpha"))).rejects.toThrow(/malformed/);
		expect(readFileSync(file(), "utf8")).toBe("{broken");
	});

	it("writes atomically with 0600 and keeps the active snapshot until restart", async () => {
		save(["bl/*"]);
		const store = new ModelBlacklistStore(file());
		await store.toggle(model("bl", "alpha"));

		expect(savedRules()).toEqual(["bl/*", "!bl/alpha"]);
		expect(statSync(file()).mode & 0o777).toBe(0o600);
		expect(readdirSync(directory)).toEqual(["model-blacklist.json"]);
		expect(store.active.isBlocked(model("bl", "alpha"))).toBe(true);
		expect(store.saved().isBlocked(model("bl", "alpha"))).toBe(false);
		expect(new ModelBlacklistStore(file()).active.isBlocked(model("bl", "alpha"))).toBe(false);
	});

	it("serializes concurrent toggles and creates the directory on first write", async () => {
		const store = new ModelBlacklistStore(join(directory, "nested", "model-blacklist.json"));
		await Promise.all([store.toggle(model("bl", "a")), store.toggle(model("bl", "b"))]);
		expect(store.saved().rules).toEqual(["bl/a", "bl/b"]);
	});
});
