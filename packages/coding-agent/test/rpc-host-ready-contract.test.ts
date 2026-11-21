import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { waitForStderr } from "./helpers/rpc-socket-host-support.ts";

describe("RPC host readiness wait (senpi#7141)", () => {
	it("resolves when the host prints its listening line", async () => {
		const child = spawn(process.execPath, [
			"-e",
			'process.stderr.write("senpi rpc listening on unix:///tmp/x.sock\n")',
		]);
		await waitForStderr(child, "senpi rpc listening on unix:///tmp/x.sock");
		child.kill();
	});

	it("rejects promptly with the child's stderr when the host exits before readiness", async () => {
		const child = spawn(process.execPath, [
			"-e",
			'process.stderr.write("boot failed: synthetic\n"); process.exit(3)',
		]);
		const startedAt = Date.now();
		await expect(waitForStderr(child, "senpi rpc listening on unix:///never")).rejects.toThrow(
			/boot failed: synthetic/,
		);
		// The old fixed-budget wait hung its full window on a dead host; exit-awareness must not.
		expect(Date.now() - startedAt).toBeLessThan(5000);
	});
});
