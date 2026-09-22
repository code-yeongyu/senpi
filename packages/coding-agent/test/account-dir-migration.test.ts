import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	resolveAccountsDirectory,
	writeConfigDirCredential,
} from "../src/core/extensions/builtin/anthropic-subscription/config-dir-credentials.ts";

const LEGACY = "claude-sdk-oauth-accounts";
const CANON = "anthropic-subscription-accounts";
const dirs: string[] = [];
function agentDir(): string {
	const d = mkdtempSync(join(tmpdir(), "t6-accts-"));
	dirs.push(d);
	return d;
}
function seedLegacy(agent: string, slot: string, body: string): void {
	const p = join(agent, LEGACY, slot);
	mkdirSync(p, { recursive: true });
	writeFileSync(join(p, ".credentials.json"), body);
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("account directory migration (senpi#1989)", () => {
	it("moves the legacy dir to the canonical name, preserving slot names and contents", () => {
		const agent = agentDir();
		seedLegacy(agent, "default", '{"a":1}');
		seedLegacy(agent, "work", '{"b":2}');
		const base = resolveAccountsDirectory(agent);
		expect(base).toBe(join(agent, CANON));
		expect(existsSync(join(agent, LEGACY))).toBe(false);
		expect(readdirSync(join(agent, CANON)).sort()).toEqual(["default", "work"]);
		expect(readFileSync(join(agent, CANON, "default", ".credentials.json"), "utf8")).toBe('{"a":1}');
	});

	it("is idempotent, and a fresh install uses the canonical name without creating anything", () => {
		const agent = agentDir();
		seedLegacy(agent, "default", "{}");
		resolveAccountsDirectory(agent);
		expect(resolveAccountsDirectory(agent)).toBe(join(agent, CANON));
		const fresh = agentDir();
		expect(resolveAccountsDirectory(fresh)).toBe(join(fresh, CANON));
		expect(existsSync(join(fresh, LEGACY))).toBe(false);
		expect(existsSync(join(fresh, CANON))).toBe(false);
	});

	it("never merges when both exist: keeps the canonical tree, sets the legacy aside with a suffix", () => {
		const agent = agentDir();
		seedLegacy(agent, "old", "{}");
		mkdirSync(join(agent, CANON, "new"), { recursive: true });
		expect(resolveAccountsDirectory(agent)).toBe(join(agent, CANON));
		expect(readdirSync(join(agent, CANON))).toEqual(["new"]);
		expect(readdirSync(agent).some((e) => e.startsWith(`${LEGACY}.`) && e.endsWith(".bak"))).toBe(true);
		expect(existsSync(join(agent, LEGACY))).toBe(false);
	});

	it("writeConfigDirCredential writes under the canonical dir after migration", () => {
		const agent = agentDir();
		seedLegacy(agent, "default", "{}");
		const out = writeConfigDirCredential(agent, { name: "default", refresh: "r", expires: 0 } as never, "tok");
		expect(out).toBe(join(agent, CANON, "default"));
		expect(existsSync(join(agent, CANON, "default", ".credentials.json"))).toBe(true);
	});
});
