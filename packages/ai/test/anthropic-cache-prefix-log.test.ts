import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { logAnthropicCachePrefix } from "../src/api/anthropic-cache-prefix-log.ts";

const secret = "PRIVATE_FIXTURE_RAW_TEXT";
const params = {
	model: secret,
	betas: [secret],
	system: [{ type: "text", text: secret, cache_control: { type: "ephemeral" } }],
	tools: [{ name: secret, input_schema: { description: secret } }],
	messages: [{ role: "user", content: [{ type: "text", text: secret }] }],
};

describe("final Anthropic cache prefix diagnostics", () => {
	it("partitions by the effective case-insensitive beta set, not header order", () => {
		const dir = mkdtempSync(join(tmpdir(), "cache-prefix-partition-"));
		try {
			for (const sources of [
				[{ "Anthropic-Beta": "a,b" }],
				[{ "anthropic-beta": "b, a,a" }],
				[{ "anthropic-beta": "a,b" }, { "Anthropic-Beta": "c" }],
			]) {
				logAnthropicCachePrefix({ provider: secret, id: secret }, params, sources, {
					SENPI_DEBUG_CACHE_PREFIX: dir,
				});
			}
			const rows = readFileSync(join(dir, "cache-prefix.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(rows[0].partition).toEqual(rows[1].partition);
			expect(rows[2].partition.hash).not.toBe(rows[0].partition.hash);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("writes nothing by default or with a disabled flag", () => {
		const builtin = vi.spyOn(process, "getBuiltinModule");
		try {
			for (const flag of [undefined, "", "0"]) {
				logAnthropicCachePrefix({ provider: secret, id: secret }, params, [], {
					SENPI_DEBUG_CACHE_PREFIX: flag,
				});
			}
			expect(builtin).not.toHaveBeenCalled();
		} finally {
			builtin.mockRestore();
		}
	});

	it("writes only hashes lengths and checkpoint coordinates to a private file", () => {
		const dir = mkdtempSync(join(tmpdir(), "cache-prefix-on-"));
		try {
			logAnthropicCachePrefix({ provider: secret, id: secret }, params, [{ "anthropic-beta": secret }], {
				SENPI_DEBUG_CACHE_PREFIX: dir,
			});
			const path = join(dir, "cache-prefix.jsonl");
			const raw = readFileSync(path, "utf8");
			expect(raw).not.toContain(secret);
			// Windows reports DOS read/write flags, not POSIX group/other mode bits.
			if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
			const record = JSON.parse(raw);
			expect(record.partition.hash).toMatch(/^[0-9a-f]{64}$/);
			expect(record.system).toHaveLength(1);
			expect(record.tools).toHaveLength(1);
			expect(record.messages[0].blocks).toHaveLength(1);
			expect(record.checkpoints).toEqual([["system", 0]]);
			expect(record.system[0].bytes).toBeGreaterThan(0);
			expect(record.system[0].hash).toMatch(/^[0-9a-f]{64}$/);
			const assertLeaves = (value: unknown): void => {
				if (Array.isArray(value)) {
					for (const item of value) assertLeaves(item);
				} else if (value !== null && typeof value === "object") {
					for (const item of Object.values(value)) assertLeaves(item);
				} else if (typeof value === "number") {
					expect(Number.isInteger(value) && value >= 0).toBe(true);
				} else {
					expect(value).toMatch(/^(?:[0-9a-f]{64}|system|tools|messages)$/);
				}
			};
			assertLeaves(record);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
