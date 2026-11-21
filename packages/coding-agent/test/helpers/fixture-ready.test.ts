import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	captureStderr,
	caseBudget,
	REPORT_MARGIN_MS,
	waitForFixtureExit,
	waitForFixtureFile,
	waitForFixtureMessage,
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

/** Resolves at the fixture's first stderr write, so a short bound below measures the wait, not a slow spawn. */
async function wrote(child: ChildProcess): Promise<void> {
	if (child.stderr) await once(child.stderr, "data");
}

function fixture(script: string): { child: ChildProcess; output: () => string; gone: Promise<unknown> } {
	const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "pipe"] });
	children.push(child);
	return { child, output: captureStderr(child), gone: once(child, "exit") };
}

describe("waitForFixtureFile", () => {
	it("rejects with the cause when the fixture's exit promise itself rejects, never leaving it unhandled", async () => {
		const ready = join(scratch(), "ready");
		const spawnFailure = new Error("spawn ENOENT");
		const gone = Promise.reject(spawnFailure);
		const waited = waitForFixtureFile(ready, { timeoutMs: budget(20_000), output: () => "", gone });
		await expect(waited).rejects.toMatchObject({ cause: spawnFailure });
	});

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
		const { child, output, gone } = fixture(`process.stderr.write("still booting\\n"); setInterval(() => {}, 1000);`);
		await wrote(child);
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
		await wrote(child);
		await expect(waitForFixtureExit(child, { timeoutMs: 500, output }, "owner")).rejects.toThrow(
			/owner did not exit within 500ms[\s\S]*holding/,
		);
	}, 20_000);
});

describe("waitForFixtureMessage", () => {
	function reporter(script: string): { child: ChildProcess; output: () => string } {
		const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
		children.push(child);
		return { child, output: captureStderr(child) };
	}
	const readyType = (message: unknown): string | undefined =>
		typeof message === "object" && message !== null && "type" in message && message.type !== "noise"
			? String(message.type)
			: undefined;

	it("settles on the first message it accepts, skipping the ones it does not", async () => {
		const { child, output } = reporter(`process.send({ type: "noise" }); process.send({ type: "ready" });`);
		await expect(
			waitForFixtureMessage(child, readyType, { timeoutMs: budget(20_000), output }, "caller"),
		).resolves.toBe("ready");
	});

	it("still delivers a report the fixture sent right before it exited", async () => {
		// rpc-owner-caller.ts reports a failure, disconnects and exits; the exit must not win over that report.
		const { child, output } = reporter(
			`process.send({ type: "failure" }, () => { process.exitCode = 1; process.disconnect(); });`,
		);
		await expect(
			waitForFixtureMessage(child, readyType, { timeoutMs: budget(20_000), output }, "caller"),
		).resolves.toBe("failure");
	});

	it("fails as soon as a fixture exits without reporting, with its status and output", async () => {
		const { child, output } = reporter(`process.stderr.write("boot refused\\n"); process.exit(3);`);
		// The bound outlives this case: only the exit can settle the wait in time.
		await expect(waitForFixtureMessage(child, readyType, { timeoutMs: 600_000, output }, "caller")).rejects.toThrow(
			/caller exited \(code 3, signal null\) before it reported[\s\S]*boot refused/,
		);
	});

	it("fails with the error `accept` throws", async () => {
		const { child, output } = reporter(`process.send({ type: "ready" }); setInterval(() => {}, 1000);`);
		const refuse = (): never => {
			throw new Error("missing transferred exit pipe");
		};
		await expect(
			waitForFixtureMessage(child, refuse, { timeoutMs: budget(20_000), output }, "caller"),
		).rejects.toThrow("missing transferred exit pipe");
	});

	it("fails at its bound, with the output, when a live fixture never reports", async () => {
		const { child, output } = reporter(`process.stderr.write("still booting\\n"); setInterval(() => {}, 1000);`);
		await wrote(child);
		await expect(waitForFixtureMessage(child, readyType, { timeoutMs: 500, output }, "caller")).rejects.toThrow(
			/caller did not report within 500ms[\s\S]*still booting/,
		);
	});
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

// The bound is per CASE: `beforeEach` restarts the clock, so time a previous case spent never shrinks the
// next case's budget. The clock is faked (Date only), so both cases measure exact elapsed time.
describe("caseBudget restarts for every case", () => {
	beforeAll(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
	});
	afterAll(() => {
		vi.useRealTimers();
	});

	it("counts the time this case spent", () => {
		vi.advanceTimersByTime(10_000);
		expect(budget(20_000)).toBe(20_000 - REPORT_MARGIN_MS - 10_000);
	});

	it("starts the next case with its whole budget again", () => {
		expect(budget(20_000)).toBe(20_000 - REPORT_MARGIN_MS);
	});
});
