/**
 * Neo daemon registry tests (plan task 15 groups g + h).
 *
 * (g) registry atomicity: temp+rename, 0600 permissions.
 * (h) stale-registry cleanup: dead-pid record + socket removed before rebind.
 * Plus cwd-key scheme parity and pid-liveness detection.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cleanupStaleNeoDaemon,
	isPidAlive,
	neoDaemonCwdKey,
	neoDaemonRegistryPath,
	readNeoDaemonRecord,
	reassertNeoDaemonRecord,
	removeNeoDaemonRecord,
	writeNeoDaemonRecord,
} from "../src/modes/rpc/neo-daemon-registry.ts";

describe("neo daemon registry", () => {
	let agentDir: string;
	const cwd = "/tmp/neo-registry-test-cwd";

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "neo-registry-"));
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("cwd-key uses the session-manager safe-path scheme", () => {
		expect(neoDaemonCwdKey("/Users/alice/proj")).toBe("--Users-alice-proj--");
		// Colons and backslashes are flattened to dashes too.
		expect(neoDaemonCwdKey("/a:b/c")).toBe("--a-b-c--");
	});

	it("writes the record atomically (temp+rename) leaving no temp files", () => {
		writeNeoDaemonRecord(agentDir, cwd, { version: 1, socket: "/tmp/s.sock", pid: 1234, token: "tok" });
		const dir = join(agentDir, "neo-daemon");
		const files = readdirSync(dir);
		// Only the final record file remains — no `.tmp` leftovers.
		expect(files).toEqual([`${neoDaemonCwdKey(cwd)}.json`]);
		const record = readNeoDaemonRecord(agentDir, cwd);
		expect(record).toEqual({ version: 1, socket: "/tmp/s.sock", pid: 1234, token: "tok" });
	});

	it("writes the record with 0600 permissions (owner-only)", () => {
		writeNeoDaemonRecord(agentDir, cwd, { version: 1, socket: "/tmp/s.sock", pid: 1234, token: "tok" });
		const path = neoDaemonRegistryPath(agentDir, cwd);
		const mode = statSync(path).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("returns undefined for a missing or malformed record", () => {
		expect(readNeoDaemonRecord(agentDir, cwd)).toBeUndefined();
		const dir = join(agentDir, "neo-daemon");
		mkdirSync(dir, { recursive: true });
		writeFileSync(neoDaemonRegistryPath(agentDir, cwd), "not json at all");
		expect(readNeoDaemonRecord(agentDir, cwd)).toBeUndefined();
		writeFileSync(neoDaemonRegistryPath(agentDir, cwd), JSON.stringify({ version: 1 }));
		expect(readNeoDaemonRecord(agentDir, cwd)).toBeUndefined();
	});

	it("isPidAlive is true for the current process and false for a dead pid", () => {
		expect(isPidAlive(process.pid)).toBe(true);
		// A very high pid is extremely unlikely to be alive.
		expect(isPidAlive(2_147_400_000)).toBe(false);
		expect(isPidAlive(0)).toBe(false);
		expect(isPidAlive(-1)).toBe(false);
	});

	it("cleans up a stale record (dead pid) and its socket before rebind", () => {
		const staleSocket = join(agentDir, "stale.sock");
		writeFileSync(staleSocket, ""); // stand-in for a leftover socket file
		writeNeoDaemonRecord(agentDir, cwd, { version: 1, socket: staleSocket, pid: 2_147_400_000, token: "tok" });

		const cleaned = cleanupStaleNeoDaemon(agentDir, cwd);
		expect(cleaned).toBe(true);
		expect(readNeoDaemonRecord(agentDir, cwd)).toBeUndefined();
		expect(existsSync(staleSocket)).toBe(false);
	});

	it("does NOT clean up a live record (alive pid)", () => {
		writeNeoDaemonRecord(agentDir, cwd, { version: 1, socket: "/tmp/s.sock", pid: process.pid, token: "tok" });
		const cleaned = cleanupStaleNeoDaemon(agentDir, cwd);
		expect(cleaned).toBe(false);
		expect(readNeoDaemonRecord(agentDir, cwd)).toBeDefined();
	});

	it("removeNeoDaemonRecord is idempotent", () => {
		writeNeoDaemonRecord(agentDir, cwd, { version: 1, socket: "/tmp/s.sock", pid: 1, token: "tok" });
		removeNeoDaemonRecord(agentDir, cwd);
		removeNeoDaemonRecord(agentDir, cwd); // no throw
		expect(readNeoDaemonRecord(agentDir, cwd)).toBeUndefined();
	});

	it("reassertNeoDaemonRecord rewrites a missing record and reports it (self-heal)", () => {
		const record = { version: 1, socket: "/tmp/heal.sock", pid: process.pid, token: "heal-tok" };
		// Missing → written.
		expect(reassertNeoDaemonRecord(agentDir, cwd, record)).toBe(true);
		expect(readNeoDaemonRecord(agentDir, cwd)).toEqual(record);
	});

	it("reassertNeoDaemonRecord rewrites a corrupt/mismatched record", () => {
		const record = { version: 1, socket: "/tmp/heal.sock", pid: process.pid, token: "heal-tok" };
		// Corrupt JSON on disk → rewritten.
		mkdirSync(join(agentDir, "neo-daemon"), { recursive: true });
		writeFileSync(neoDaemonRegistryPath(agentDir, cwd), "{ corrupt");
		expect(reassertNeoDaemonRecord(agentDir, cwd, record)).toBe(true);
		expect(readNeoDaemonRecord(agentDir, cwd)).toEqual(record);
		// A record for a DIFFERENT socket/token/pid → rewritten to this daemon's.
		writeNeoDaemonRecord(agentDir, cwd, { version: 1, socket: "/tmp/other.sock", pid: 999999, token: "other" });
		expect(reassertNeoDaemonRecord(agentDir, cwd, record)).toBe(true);
		expect(readNeoDaemonRecord(agentDir, cwd)).toEqual(record);
	});

	it("reassertNeoDaemonRecord is a no-op when the record already matches (never fights a valid record)", () => {
		const record = { version: 1, socket: "/tmp/heal.sock", pid: process.pid, token: "heal-tok" };
		writeNeoDaemonRecord(agentDir, cwd, record);
		const path = neoDaemonRegistryPath(agentDir, cwd);
		const before = statSync(path).mtimeMs;
		// Matching record → no write, returns false.
		expect(reassertNeoDaemonRecord(agentDir, cwd, record)).toBe(false);
		expect(statSync(path).mtimeMs).toBe(before);
	});
});
