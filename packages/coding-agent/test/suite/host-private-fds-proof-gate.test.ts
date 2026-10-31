import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTable } from "../../src/private-fds.ts";

const usablePair = { isPipe: () => true, clearInherit: () => true, ipc: null };

// #4898: the release proof enables pairs only on win32 under the Bun the proof ran on.
describe("Windows pair release proof (#4898)", () => {
	it("accepts the ordered pair on win32 at the proven Bun", () => {
		const result = parseTable('{"a":[5,6]}', { ...usablePair, platform: "win32", bun: "1.4.4" });
		expect(result.entries.get("a")).toEqual([5, 6]);
	});

	it.each([
		{ label: "another Bun", platform: "win32" as const, bun: "1.4.5" },
		{ label: "no Bun", platform: "win32" as const, bun: undefined },
		{ label: "Linux", platform: "linux" as const, bun: "1.4.4" },
		{ label: "macOS", platform: "darwin" as const, bun: "1.4.4" },
	])("refuses the pair on $label", ({ platform, bun }) => {
		expect(parseTable('{"a":[5,6]}', { ...usablePair, platform, bun }).entries.get("a")).toBeNull();
	});
});

describe.skipIf(process.platform !== "win32")("compiled Bun Windows stale table (#4898)", () => {
	it("refuses unopened named handles without aborting capture", async () => {
		const root = await mkdtemp(join(tmpdir(), "private-fd-stale-"));
		const executable = join(root, "private-stale.exe");
		const fixture = join(import.meta.dirname, "../fixtures/private-fd-stale-table.ts");
		try {
			const build = spawn("bun", ["build", "--compile", fixture, "--outfile", executable], { stdio: "pipe" });
			const built = once(build, "close", { signal: AbortSignal.timeout(120_000) });
			let buildErrors = "";
			build.stderr?.on("data", (chunk: Buffer) => {
				buildErrors += chunk.toString();
			});
			expect((await built)[0], buildErrors).toBe(0);
			const child = spawn(executable, [], {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, SENPI_PRIVATE_FDS: '{"pair":[40,41],"bare":42}' },
			});
			const closed = once(child, "close", { signal: AbortSignal.timeout(30_000) });
			let report = "";
			let errors = "";
			child.stdout?.on("data", (chunk: Buffer) => {
				report += chunk.toString();
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				errors += chunk.toString();
			});
			expect((await closed)[0], errors).toBe(0);
			expect(JSON.parse(report)).toEqual({ pair: null, bare: null });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
