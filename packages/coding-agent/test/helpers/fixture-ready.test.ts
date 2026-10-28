import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	captureStderr,
	caseBudget,
	REPORT_MARGIN_MS,
	waitForFixtureExit,
	waitForFixtureFile,
} from "./fixture-ready.ts";

const roots: string[] = [];
const children: ChildProcess[] = [];
const budget = caseBudget();

afterEach(() => {
	for (const child of children.splice(0)) child.kill("SIGKILL");
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), "senpi-fixture-ready-"));
	roots.push(root);
	return root;
}

function fixture(script: string): { child: ChildProcess; output: () => string; gone: Promise<unknown> } {
	const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "pipe"] });
	children.push(child);
	return { child, output: captureStderr(child), gone: once(child, "exit") };
}

describe("waitForFixtureFile", () => {
	it("settles on the real creation event of a file written after it subscribed", async () => {
		const ready = join(scratch(), "ready");
		const waited = waitForFixtureFile(ready, { timeoutMs: budget(20_000), output: () => "" });
		writeFileSync(ready, "1");
		await expect(waited).resolves.toBeUndefined();
	}, 20_000);

	it("settles when the file already exists", async () => {
		const ready = join(scratch(), "ready");
		writeFileSync(ready, "1");
		await expect(waitForFixtureFile(ready, { timeoutMs: budget(20_000), output: () => "" })).resolves.toBeUndefined();
	}, 20_000);

	it("fails as soon as a never-ready fixture exits, long before the bound, and reports its output", async () => {
		const ready = join(scratch(), "ready");
		const { output, gone } = fixture(
			`process.stderr.write("boot refused: internal_key_unavailable\\n"); process.exit(3);`,
		);
		const startedAt = Date.now();
		// The bound is 30s: a wait that only had the timer would report 30s later, and this case would time out.
		await expect(waitForFixtureFile(ready, { timeoutMs: 30_000, output, gone })).rejects.toThrow(
			/exited first[\s\S]*internal_key_unavailable/,
		);
		expect(Date.now() - startedAt).toBeLessThan(10_000);
	}, 20_000);

	it("still fails at its bound, with the output, when a live fixture never writes", async () => {
		const ready = join(scratch(), "ready");
		const { output, gone } = fixture(`process.stderr.write("still booting\\n"); setInterval(() => {}, 1000);`);
		await expect(waitForFixtureFile(ready, { timeoutMs: 500, output, gone })).rejects.toThrow(
			/was not written within 500ms[\s\S]*still booting/,
		);
	}, 20_000);

	it("reports a missing file as a failure even when the fixture printed nothing", async () => {
		const ready = join(scratch(), "ready");
		await expect(waitForFixtureFile(ready, { timeoutMs: 200, output: () => "" })).rejects.toThrow(
			/<no fixture output>/,
		);
	}, 20_000);
});

describe("waitForFixtureExit", () => {
	it("settles on the fixture's exit event", async () => {
		const { child, output } = fixture(`setTimeout(() => process.exit(0), 50);`);
		await expect(waitForFixtureExit(child, { timeoutMs: budget(20_000), output }, "owner")).resolves.toBeUndefined();
	}, 20_000);

	it("fails at its bound with the fixture's output when it never exits", async () => {
		const { child, output } = fixture(`process.stderr.write("holding\\n"); setInterval(() => {}, 1000);`);
		await expect(waitForFixtureExit(child, { timeoutMs: 500, output }, "owner")).rejects.toThrow(
			/owner did not exit within 500ms[\s\S]*holding/,
		);
	}, 20_000);
});

describe("caseBudget", () => {
	it("derives the wait's bound from the case's own timeout, minus the reporting margin", () => {
		const remaining = budget(20_000);
		expect(remaining).toBeLessThanOrEqual(20_000 - REPORT_MARGIN_MS);
		expect(remaining).toBeGreaterThan(20_000 - REPORT_MARGIN_MS - 5_000);
	});

	it("never returns a non-positive bound for a case that already spent its budget", () => {
		expect(budget(0)).toBe(1_000);
	});
});
