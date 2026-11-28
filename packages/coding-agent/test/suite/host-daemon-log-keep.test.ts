/**
 * senpi#7553 review: the daemon log a fresh start keeps (`stderr.prev.log`) is capped at 1 MiB, and the cap must cut at
 * a line boundary: a kept file never opens inside a line (or inside a multi-byte UTF-8 character), and the marker that
 * separates one kept generation from the next always survives the cap.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { keepPreviousDaemonLog } from "../../src/modes/rpc/host-daemon-log.ts";

const MIB = 1024 * 1024;
const dirs: string[] = [];

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function daemonDir() {
	const dir = await mkdtemp(join(tmpdir(), "senpi-daemon-log-"));
	dirs.push(dir);
	return { stderrLog: join(dir, "stderr.log"), previousStderrLog: join(dir, "stderr.prev.log") };
}

/** `count` lines of multi-byte text, numbered so the newest one is recognisable. */
function lines(count: number, tag: string): string {
	return Array.from({ length: count }, (_, index) => `${tag} ${index} ${"é한".repeat(20)}\n`).join("");
}

function expectWholeLines(kept: Buffer): string {
	const text = kept.toString("utf8");
	expect(Buffer.from(text, "utf8").equals(kept)).toBe(true);
	expect(kept.length).toBeLessThanOrEqual(MIB);
	return text;
}

describe("the daemon log a fresh start keeps", () => {
	it("keeps the marker and whole lines when the restarted log alone is over the cap", async () => {
		const paths = await daemonDir();
		await writeFile(paths.stderrLog, lines(30_000, "current"));

		expect(await keepPreviousDaemonLog(paths)).toBeUndefined();

		const text = expectWholeLines(await readFile(paths.previousStderrLog));
		expect(text.startsWith("--- daemon log kept by a fresh start at ")).toBe(true);
		expect(text.split("\n")[1]).toMatch(/^current \d+ /);
		expect(text.endsWith(`current 29999 ${"é한".repeat(20)}\n`)).toBe(true);
	});

	it("drops the oldest whole lines of an earlier kept log to make room", async () => {
		const paths = await daemonDir();
		await writeFile(paths.previousStderrLog, lines(15_000, "earlier"));
		await writeFile(paths.stderrLog, lines(5_000, "current"));

		expect(await keepPreviousDaemonLog(paths)).toBeUndefined();

		const text = expectWholeLines(await readFile(paths.previousStderrLog));
		expect(text).toMatch(/^earlier \d+ /);
		expect(text).toContain(`earlier 14999 ${"é한".repeat(20)}\n--- daemon log kept by a fresh start at `);
		expect(text.endsWith(`current 4999 ${"é한".repeat(20)}\n`)).toBe(true);
	});
});
