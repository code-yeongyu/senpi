import { mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addGrant, lockGrantsFile } from "../../src/core/extensions/builtin/mcp/env-grants-store.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// A symlinked directory gives the grants file a second spelling, so the lock library keeps a separate in-process
// entry for each holder, as separate processes would (senpi#6431, the same race as #6428).
function target(): { file: string; lockDir: string; alias: (name: string) => string } {
	const base = mkdtempSync(join(tmpdir(), "senpi-6431-"));
	roots.push(base);
	const real = mkdtempSync(join(base, "real-"));
	const file = join(real, "mcp-env-grants.json");
	writeFileSync(file, "{}");
	const alias = (name: string): string => {
		const link = join(base, name);
		symlinkSync(real, link, "dir");
		return join(link, "mcp-env-grants.json");
	};
	return { file, lockDir: `${file}.lock`, alias };
}

describe("an MCP grants writer that lost its lock without learning it (senpi#6431)", () => {
	it("#given a grants lock taken over after going stale #when the first holder releases #then the new holder's lock survives", async () => {
		const { file, lockDir, alias } = target();
		const stale = 2_000;
		const first = await lockGrantsFile(file, { stale });
		// The first holder stalls past the stale bound: backdate its lock directory.
		const old = new Date(Date.now() - 10 * stale);
		utimesSync(lockDir, old, old);
		const second = await lockGrantsFile(alias("second"), { stale, lockfilePath: lockDir });

		await first.release();

		expect(statSync(lockDir).isDirectory()).toBe(true);
		expect(first.lost()).toBeDefined();
		await second.release();
		expect(() => statSync(lockDir)).toThrow();
	});
});

describe("an MCP grant saved through the real store (senpi#6431)", () => {
	it("#given a normal grant write #when it completes #then neither the lock directory nor its owner token is left behind", async () => {
		const { file } = target();
		rmSync(file);
		await addGrant(file, "a".repeat(64), { project: "p", skill: "s", server: "srv" }, ["TOKEN"]);
		expect(readdirSync(dirname(file)).sort()).toEqual(["mcp-env-grants.json"]);
	});
});
