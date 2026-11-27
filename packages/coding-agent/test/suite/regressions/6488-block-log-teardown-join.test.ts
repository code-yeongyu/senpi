import fs, { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as blockLog from "../../../src/core/credential-pool/block-log.ts";
import { PendingBlockLogRemovalError } from "../../support/host-scratch-removal-guard.ts";

// senpi#6488: the pool appends its block log without awaiting it (senpi#5992). A teardown that removed the test's
// temp tree while that append was creating the log failed with ENOTEMPTY. The test setup's removal guard makes an
// awaited `rm` of a tree join the appends still writing inside it, and makes `rmSync` refuse while one is pending.

const realAppendFile = fs.promises.appendFile;
const realSettledWithin = blockLog.settledCredentialBlockLogsWithin;
let restoreAppendFile: (() => void) | undefined;

afterEach(() => {
	restoreAppendFile?.();
	restoreAppendFile = undefined;
	vi.restoreAllMocks();
});

function parkAppends(): {
	reached: Promise<string>;
	release: () => void;
	directoryAtAppend: () => boolean | undefined;
} {
	let release = (): void => {};
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	let reach = (_path: string): void => {};
	const reached = new Promise<string>((resolve) => {
		reach = resolve;
	});
	let directoryPresent: boolean | undefined;
	const parked: typeof fs.promises.appendFile = async (path, data, options) => {
		reach(String(path));
		await released;
		directoryPresent = existsSync(dirname(String(path)));
		return realAppendFile(path, data, options);
	};
	fs.promises.appendFile = parked;
	syncBuiltinESMExports();
	restoreAppendFile = () => {
		fs.promises.appendFile = realAppendFile;
		syncBuiltinESMExports();
	};
	return { reached, release, directoryAtAppend: () => directoryPresent };
}

async function parkedAppendIn(dir: string): Promise<{ logPath: string; append: ReturnType<typeof parkAppends> }> {
	const logPath = join(dir, "credential-pool-blocks.jsonl");
	const append = parkAppends();
	blockLog.appendCredentialBlockLog(logPath, {
		at: new Date(0).toISOString(),
		provider: "test",
		slot: "default",
		reason: "rate_limit",
	});
	expect(await append.reached).toBe(logPath);
	return { logPath, append };
}

describe("removing a tree with a block-log append in flight", () => {
	it("an awaited rm lets the append land before it removes anything", async () => {
		const dir = mkdtempSync(join(tmpdir(), "senpi-6488-"));
		const { logPath, append } = await parkedAppendIn(dir);
		const events: string[] = [];
		// The parked append is released once the removal is seen joining it, or, if it never joins, once it is done.
		vi.spyOn(blockLog, "settledCredentialBlockLogsWithin").mockImplementation((directory) => {
			events.push("removal-joins");
			append.release();
			return realSettledWithin(directory);
		});

		events.push("removal-start");
		const removal = rm(dir, { recursive: true, force: true }).then(() => {
			events.push("removal-done");
			append.release();
		});
		const appended = blockLog.flushCredentialBlockLog(logPath).then(() => events.push("append-settled"));
		await Promise.all([removal, appended]);

		expect(events).toEqual(["removal-start", "removal-joins", "append-settled", "removal-done"]);
		expect(append.directoryAtAppend()).toBe(true);
		expect(existsSync(dir)).toBe(false);
	});

	it("rmSync refuses while the append is pending and removes the tree once it landed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "senpi-6488-"));
		const { logPath, append } = await parkedAppendIn(dir);

		expect(() => fs.rmSync(dir, { recursive: true, force: true })).toThrow(PendingBlockLogRemovalError);
		expect(existsSync(dir)).toBe(true);

		append.release();
		await blockLog.flushCredentialBlockLog(logPath);
		fs.rmSync(dir, { recursive: true, force: true });
		expect(existsSync(dir)).toBe(false);
	});
});
