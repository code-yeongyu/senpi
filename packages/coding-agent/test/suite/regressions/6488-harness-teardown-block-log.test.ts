import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendCredentialBlockLog, flushCredentialBlockLog } from "../../../src/core/credential-pool/block-log.ts";
import { createHarness } from "../harness.ts";

// senpi#6488: the removal guard's rmSync refuses while a credential block-log append is pending inside the tree, so a
// harness teardown that removed its temp dir with rmSync threw when a suite's pool had just blocked a slot.

describe("harness teardown with a block-log append in flight", () => {
	it("waits for the append and removes the temp dir without throwing", async () => {
		const harness = await createHarness();
		const logPath = join(harness.tempDir, "agent", "credential-pool-blocks.jsonl");
		appendCredentialBlockLog(logPath, {
			at: new Date(0).toISOString(),
			provider: "test",
			slot: "default",
			reason: "rate_limit",
		});

		await expect(harness.cleanup()).resolves.toBeUndefined();
		await flushCredentialBlockLog(logPath);
		expect(existsSync(harness.tempDir)).toBe(false);
	});
});
