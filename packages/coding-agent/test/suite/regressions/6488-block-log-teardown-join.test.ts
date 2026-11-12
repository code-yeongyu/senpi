import fs, { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendCredentialBlockLog } from "../../../src/core/credential-pool/block-log.ts";

// senpi#6488: the pool appends its block log without awaiting it (senpi#5992). A teardown that removed the test's
// temp tree while that append was creating the log failed with ENOTEMPTY. The test setup's removal guard makes an
// awaited `rm` of a tree join the appends still writing inside it; this parks one append and checks the join.

/** Event-loop turns an unguarded removal of a near-empty tree needs to finish; a turn budget, not a sleep. */
const REMOVAL_TURNS = 2_000;
const realAppendFile = fs.promises.appendFile;
let restoreAppendFile: (() => void) | undefined;

afterEach(() => {
	restoreAppendFile?.();
	restoreAppendFile = undefined;
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

async function turns(count: number): Promise<"turns"> {
	for (let turn = 0; turn < count; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
	return "turns";
}

describe("removing a tree with a block-log append in flight", () => {
	it("waits for the append to land before it removes anything", async () => {
		const dir = mkdtempSync(join(tmpdir(), "senpi-6488-"));
		const logPath = join(dir, "credential-pool-blocks.jsonl");
		const append = parkAppends();
		appendCredentialBlockLog(logPath, {
			at: new Date(0).toISOString(),
			provider: "test",
			slot: "default",
			reason: "rate_limit",
		});
		expect(await append.reached).toBe(logPath);

		const removal = rm(dir, { recursive: true, force: true });
		const first = await Promise.race([removal.then(() => "removed" as const), turns(REMOVAL_TURNS)]);
		expect(first).toBe("turns");

		append.release();
		await removal;
		expect(append.directoryAtAppend()).toBe(true);
		expect(existsSync(dir)).toBe(false);
	});
});
