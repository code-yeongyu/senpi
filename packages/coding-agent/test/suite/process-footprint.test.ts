import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseProcStatusRssAnon, readOwnFootprint, readProcessFootprint } from "../../src/core/process-footprint.ts";

// senpi#2261: the shared host judged memory pressure by RSS, which stays high after memory is
// returned. The reader reports the kernel's footprint counter instead, without spawning anything.

const MEGABYTE = 1024 * 1024;
const ALLOCATED_MB = 96;
const MIN_GROWTH_MB = 64;

const PLATFORM_MEASURE: Partial<Record<NodeJS.Platform, string>> = {
	darwin: "phys_footprint",
	linux: "rss_anon",
	win32: "private_usage",
};

const footprint = z.object({ bytes: z.number(), measure: z.string() });
const fixtureResult = z.object({
	before: footprint,
	grown: footprint,
	live: footprint.nullable(),
	gone: footprint.nullable(),
	invalid: footprint.nullable(),
});

describe("process footprint reader", () => {
	it("parses RssAnon from /proc/<pid>/status text, and nothing when the field is absent", () => {
		const status = ["Name:\tbun", "VmRSS:\t  812345 kB", "RssAnon:\t  700000 kB", "RssFile:\t  100000 kB"].join("\n");
		expect(parseProcStatusRssAnon(status)).toBe(700_000 * 1024);
		expect(parseProcStatusRssAnon("Name:\tbun\nVmRSS:\t  812345 kB\n")).toBeUndefined();
	});

	it("answers for this process under Node: RssAnon on linux, labelled RSS where no counter is bound", () => {
		const own = readOwnFootprint();
		expect(Number.isFinite(own.bytes) && own.bytes > 0).toBe(true);
		expect(own.measure).toBe(process.platform === "linux" ? "rss_anon" : "rss");
		expect(readProcessFootprint(process.pid)?.measure).toBe(own.measure);
	});

	it("returns undefined for a pid it cannot read, without throwing", () => {
		for (const pid of [0, -1, 1.5, Number.NaN, 0x7fff_fff0]) {
			expect(readProcessFootprint(pid)).toBeUndefined();
		}
	});

	it("reads the platform footprint counter under Bun, for itself and a live child, and tracks allocation", () => {
		const result = runBunFixture();
		const expected = PLATFORM_MEASURE[process.platform] ?? "rss";
		expect(result.before.measure).toBe(expected);
		expect(result.before.bytes).toBeGreaterThan(0);
		expect(result.grown.bytes - result.before.bytes).toBeGreaterThanOrEqual(MIN_GROWTH_MB * MEGABYTE);
		expect(result.live?.measure).toBe(expected === "rss" ? undefined : expected);
		expect(result.gone).toBeNull();
		expect(result.invalid).toBeNull();
	}, 60_000);
});

const readerModule = fileURLToPath(new URL("../../src/core/process-footprint.ts", import.meta.url));

function runBunFixture(): z.infer<typeof fixtureResult> {
	const directory = mkdtempSync(join(tmpdir(), "senpi-footprint-"));
	const fixture = join(directory, "footprint-fixture.mjs");
	writeFileSync(fixture, fixtureSource());
	try {
		const output = execFileSync("bun", [fixture], { encoding: "utf8", timeout: 45_000 });
		return fixtureResult.parse(JSON.parse(output.trim().split("\n").at(-1) ?? "{}"));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

function fixtureSource(): string {
	return `
import { spawn } from "node:child_process";
import { readOwnFootprint, readProcessFootprint } from ${JSON.stringify(readerModule)};

const before = readOwnFootprint();
const block = new Uint8Array(${ALLOCATED_MB} * 1024 * 1024);
block.fill(1);
const grown = readOwnFootprint();

// A live child of the same user, readable through the same counter until it exits.
const child = spawn(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"], {
	stdio: ["ignore", "pipe", "ignore"],
});
await new Promise((resolve) => child.stdout.once("data", resolve));
const live = readProcessFootprint(child.pid) ?? null;
const exited = new Promise((resolve) => child.once("exit", resolve));
child.kill();
await exited;
const gone = readProcessFootprint(child.pid) ?? null;
const invalid = readProcessFootprint(0x7ffffff0) ?? null;

console.log(JSON.stringify({ before, grown, live, gone, invalid, kept: block[block.length - 1] }));
`;
}
