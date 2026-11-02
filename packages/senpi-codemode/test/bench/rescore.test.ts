import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CPU_BOUNDARY } from "../../scripts/bench-cpu-contract.ts";
import { noisyBlocks, REPS } from "./noisy-fixture.ts";

const script = fileURLToPath(new URL("../../scripts/bench-eval.ts", import.meta.url));
let dir = "";

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bench-rescore-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const saved = {
	cpuBoundary: CPU_BOUNDARY,
	reps: REPS,
	injections: [],
	blockLoads: [3, 4, 3],
	failures: [],
	runtimes: [{ id: "py", base: { available: true, version: "3.13" }, head: { available: true, version: "3.13" } }],
	series: [
		{
			scenario: "warm-cell",
			runtimeId: "py",
			present: { base: true, head: true },
			calibration: noisyBlocks(11, 0.04),
			comparison: noisyBlocks(12, 0.04),
		},
	],
};

function bench(args: readonly string[]): Promise<{ readonly code: number | null; readonly output: string }> {
	return new Promise((resolveRun, reject) => {
		const child = spawn("bun", [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			output += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			output += chunk;
		});
		child.once("error", reject);
		child.once("close", (code) => resolveRun({ code, output }));
	});
}

async function rescore(...extra: string[]) {
	const source = join(dir, "measured.json");
	const out = join(dir, "rescored.json");
	await writeFile(source, JSON.stringify(saved));
	const result = await bench(["--rescore", source, "--out", out, ...extra]);
	return { ...result, out, report: JSON.parse(await readFile(out, "utf8")) };
}

describe("rescoring a saved measurement", () => {
	it("refuses legacy embedded-clock samples instead of treating them as post-result CPU", async () => {
		// Refs senpi#3048: aggregated legacy samples cannot reconstruct serialization CPU.
		const source = join(dir, "legacy.json");
		await writeFile(source, JSON.stringify({ ...saved, cpuBoundary: undefined }));
		const out = join(dir, "legacy-rescored.json");
		const result = await bench(["--rescore", source, "--out", out]);
		const report = JSON.parse(await readFile(out, "utf8"));
		expect(result.code).toBe(2);
		expect(report.decision.verdict).toBe("REFUSED");
	}, 30_000);

	it("passes identical code and prints the per-row table without new samples", async () => {
		// Given a saved self-vs-self measurement.
		const result = await rescore();
		// Then the same comparator passes it and reports each row's threshold and band.
		expect(result.code).toBe(0);
		expect(result.output).toMatch(/warm-cell py cpu \| 0\.0\d\d \| 0\.0\d\d \| /u);
		expect(result.report.rescoredFrom).toContain("measured.json");
	}, 30_000);

	it("detects the 1.3x head injection on the saved samples and names the row", async () => {
		// When the saved run is rescored with a slowed head.
		const result = await rescore("--inject-slow", "head:warm-cell:1.3");
		// Then the regression fails the run.
		expect(result.code).toBe(1);
		expect(result.output).toContain("FAIL: warm-cell py: paired cpu ratio 1.3");
	}, 30_000);

	it("rejects a mistyped injection scenario instead of applying it as a silent no-op", async () => {
		// When the injection names a scenario that does not exist.
		const source = join(dir, "measured.json");
		await writeFile(source, JSON.stringify(saved));
		const result = await bench([
			"--rescore",
			source,
			"--out",
			join(dir, "out.json"),
			"--inject-slow",
			"head:warm-cel:1.3",
		]);
		// Then the run errors out and never reports a pass.
		expect(result.code).not.toBe(0);
		expect(result.code).not.toBeNull();
		expect(result.output).toContain("unknown scenario warm-cel");
		expect(result.output).not.toContain("bench: PASS");
	}, 30_000);

	it("refuses an injection that matches no measured series", async () => {
		// When a real scenario is injected that this measurement never ran.
		const result = await rescore("--inject-slow", "head:detach:1.3");
		// Then the vacuous injection is refused rather than judged.
		expect(result.code).toBe(2);
		expect(result.output).toContain("head:detach:1.3 matches no series measured on both sides");
	}, 30_000);

	it("reports a forced excessive A/A band as inconclusive", async () => {
		// When every row's calibration carries an eight-percent offset.
		const result = await rescore("--inject-aa-offset", "1.08");
		// Then the noise-limited rows make the run inconclusive.
		expect(result.code).toBe(3);
		expect(result.output).toContain("noise-limited");
	}, 30_000);

	it("scores the same samples with one global band through the scope knob", async () => {
		// When the global scope is selected.
		const result = await rescore("--band-scope", "global");
		// Then the report records the scope and still decides the run.
		expect(result.report.bandScope).toBe("global");
		expect(result.code).toBe(0);
	}, 30_000);

	it("refuses to rescore a report that already carries injected samples", async () => {
		// Given a source report produced with an injection.
		const source = join(dir, "injected.json");
		await writeFile(
			source,
			JSON.stringify({ ...saved, injections: [{ side: "head", scenario: "warm-cell", factor: 1.3 }] }),
		);
		// When it is rescored.
		const result = await bench(["--rescore", source, "--out", join(dir, "out.json")]);
		// Then the double injection is refused instead of judged.
		expect(result.code).toBe(2);
		expect(result.output).toContain("already carries injected samples");
	}, 30_000);
});
