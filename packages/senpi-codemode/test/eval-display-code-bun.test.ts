import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runChild } from "./eval/child-probe.ts";
import { BUN_DISPLAY_CASES, DENSE_JS_CELL } from "./eval-display-fixtures.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const modulePath = (relative: string) => JSON.stringify(fileURLToPath(new URL(relative, import.meta.url)));
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

type BunReport = {
	readonly bunVersion: string | undefined;
	readonly displays: Readonly<Record<string, string>>;
	readonly frame: readonly string[];
};

function isBunReport(value: unknown): value is BunReport {
	return value !== null && typeof value === "object" && "displays" in value && "frame" in value;
}

const driverSource = [
	`import { displayCode } from ${modulePath("../src/tool/display-code.ts")};`,
	`import { renderEvalCall } from ${modulePath("../src/tool/render.ts")};`,
	`import { callContext, renderLines } from ${modulePath("./eval-render-fixtures.ts")};`,
	`import { BUN_DISPLAY_CASES, DENSE_JS_CELL } from ${modulePath("./eval-display-fixtures.ts")};`,
	"const displays = Object.fromEntries(Object.entries(BUN_DISPLAY_CASES).map(([name, c]) => [name, displayCode(c.code, 'js')]));",
	"const call = renderEvalCall({ language: 'js', code: DENSE_JS_CELL, summary: 'preview' }, undefined, callContext({ spinnerFrame: 0, expanded: true }));",
	"process.stdout.write(JSON.stringify({ bunVersion: process.versions.bun, displays, frame: renderLines(call) }));",
].join("\n");

let tempDir = "";
let report: BunReport | undefined;

describe.skipIf(!bunAvailable)("displayCode under Bun", () => {
	beforeAll(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-display-bun-"));
		const driverPath = join(tempDir, "driver.ts");
		writeFileSync(driverPath, driverSource);
		const run = await runChild({ command: "bun", args: [driverPath], cwd: packageRoot });
		expect(run.code, run.stderr).toBe(0);
		expect(run.stderr).toBe("");
		const parsed: unknown = JSON.parse(run.stdout);
		if (!isBunReport(parsed)) throw new TypeError(`unexpected driver output: ${run.stdout}`);
		report = parsed;
	}, 240_000);

	afterAll(() => {
		if (tempDir !== "") rmSync(tempDir, { recursive: true, force: true });
	});

	it("runs the driver on Bun", () => {
		expect(typeof report?.bunVersion).toBe("string");
	});

	for (const [name, testCase] of Object.entries(BUN_DISPLAY_CASES)) {
		const title =
			testCase.expected === undefined
				? `shows the ${name} cell exactly as sent`
				: `lays out the ${name} cell with Bun, keeping literal, name, and comment text`;
		it(title, () => {
			expect(report?.displays[name]).toBe(testCase.expected ?? testCase.code);
		});
	}

	it("renders the Bun layout inside the eval cell frame", () => {
		expect(report?.frame).toContain("\u2502 for (let i = 0; i < 4; i++) {");
		expect(report?.frame).toContain("\u2502   print(d[i].text);");
		expect(report?.frame.join("\n")).not.toContain(DENSE_JS_CELL.slice(0, 40));
	});
});
