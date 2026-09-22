import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { resolveAccountsDirectory } from "../src/core/extensions/builtin/anthropic-subscription/config-dir-credentials.ts";

// No Windows CI covers the account-directory move (test-coding-agent runs on
// ubuntu-latest only), so the cross-device / sharing-violation fallback can
// only be proved by forcing rename to fail. senpi#1989 todo 6.
vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return { ...actual, renameSync: vi.fn(actual.renameSync), cpSync: vi.fn(actual.cpSync) };
});

const LEGACY = "claude-sdk-oauth-accounts";
const CANON = "anthropic-subscription-accounts";
const dirs: string[] = [];
function agentDir(): string {
	const d = mkdtempSync(join(tmpdir(), "t6-fallback-"));
	dirs.push(d);
	return d;
}
function seedLegacy(agent: string, slot: string, body: string): void {
	const p = join(agent, LEGACY, slot);
	mkdirSync(p, { recursive: true });
	writeFileSync(join(p, ".credentials.json"), body);
}
function failOnce(fn: unknown, code: string): void {
	(fn as Mock).mockImplementationOnce(() => {
		throw Object.assign(new Error(code), { code });
	});
}
afterEach(() => {
	vi.mocked(renameSync).mockClear();
	vi.mocked(cpSync).mockClear();
	vi.restoreAllMocks();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("account directory move: forced rename-failure fallback (senpi#1989)", () => {
	it("falls back to copy+remove when rename fails cross-device (EXDEV)", () => {
		const agent = agentDir();
		seedLegacy(agent, "default", '{"x":9}');
		seedLegacy(agent, "work", '{"y":8}');
		failOnce(renameSync, "EXDEV");

		const base = resolveAccountsDirectory(agent);

		expect(base).toBe(join(agent, CANON));
		expect(existsSync(join(agent, LEGACY))).toBe(false);
		expect(readdirSync(join(agent, CANON)).sort()).toEqual(["default", "work"]);
		expect(readFileSync(join(agent, CANON, "default", ".credentials.json"), "utf8")).toBe('{"x":9}');
	});

	it("falls back the same way on a Windows-style sharing violation (EPERM)", () => {
		const agent = agentDir();
		seedLegacy(agent, "default", '{"z":1}');
		failOnce(renameSync, "EPERM");

		expect(resolveAccountsDirectory(agent)).toBe(join(agent, CANON));
		expect(existsSync(join(agent, LEGACY))).toBe(false);
		expect(readFileSync(join(agent, CANON, "default", ".credentials.json"), "utf8")).toBe('{"z":1}');
	});

	it("leaves the SOURCE authoritative and no partial target when the copy also fails", () => {
		const agent = agentDir();
		seedLegacy(agent, "default", '{"keep":true}');
		failOnce(renameSync, "EXDEV");
		// Fail MID-copy: write a partial target first, so the cleanup has something
		// to remove. Throwing before any write would make the assertion below pass
		// whether or not the implementation cleans up.
		vi.mocked(cpSync).mockImplementationOnce((_src, dest) => {
			mkdirSync(join(String(dest), "default"), { recursive: true });
			writeFileSync(join(String(dest), "default", ".credentials.json"), "{partial");
			throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
		});

		const base = resolveAccountsDirectory(agent);

		// the move failed: the caller is pointed back at the legacy tree, intact
		expect(base).toBe(join(agent, LEGACY));
		expect(readFileSync(join(agent, LEGACY, "default", ".credentials.json"), "utf8")).toBe('{"keep":true}');
		expect(existsSync(join(agent, CANON))).toBe(false); // no partial target left behind
	});

	it("retries the move on the next resolve after a failure (non-fatal)", () => {
		const agent = agentDir();
		seedLegacy(agent, "default", '{"r":1}');
		failOnce(renameSync, "EXDEV");
		vi.mocked(cpSync).mockImplementationOnce((_src, dest) => {
			mkdirSync(String(dest), { recursive: true });
			throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
		});
		expect(resolveAccountsDirectory(agent)).toBe(join(agent, LEGACY));

		// next resolve: no forced failure, the move completes
		expect(resolveAccountsDirectory(agent)).toBe(join(agent, CANON));
		expect(existsSync(join(agent, LEGACY))).toBe(false);
		expect(readFileSync(join(agent, CANON, "default", ".credentials.json"), "utf8")).toBe('{"r":1}');
	});
});
