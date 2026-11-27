// senpi#7141: the socket-host readiness wait settles on the host's own line or its exit, never on a wall clock.
// The child programs are real JS (each `\\n` reaches `node -e` as an escape, not a raw newline), so a syntax
// error cannot echo the awaited text and pass the wait for the wrong reason.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { waitForStderr } from "./helpers/rpc-socket-host-support.ts";

const LISTENING = "senpi rpc listening on unix:///tmp/x.sock";

function node(program: string) {
	return spawn(process.execPath, ["-e", program]);
}

describe("RPC host readiness wait (senpi#7141)", () => {
	it("resolves on the host's listening line while the host is still running", async () => {
		const child = node(`process.stderr.write(${JSON.stringify(`${LISTENING}\n`)}); setInterval(() => {}, 1000)`);
		try {
			await waitForStderr(child, LISTENING);
			expect(child.exitCode).toBeNull();
			expect(child.signalCode).toBeNull();
		} finally {
			child.kill();
		}
	});

	it("rejects with the exit reason and the host's stderr when the host exits before its line", async () => {
		const child = node(`process.stderr.write(${JSON.stringify("boot failed: synthetic\n")}); process.exit(3)`);
		const waited = waitForStderr(child, "senpi rpc listening on unix:///never");
		await expect(waited).rejects.toThrow(/^RPC host exited \(3\) before .*boot failed: synthetic/s);
		expect(child.exitCode).toBe(3);
	});

	it("rejects at once for a host that had already exited before the wait began", async () => {
		const child = node(`process.stderr.write(${JSON.stringify("gone early\n")}); process.exit(4)`);
		await once(child, "exit");
		await expect(waitForStderr(child, "senpi rpc listening on unix:///never")).rejects.toThrow(
			/^RPC host exited \(4\) before /,
		);
	});
});
