// senpi#7282: a run's result says why its process ended. `timed_out` comes only from the spawning side's own timer; a
// process that ends on the same signal for another reason is `signaled`; a hand that predates the field leaves the
// cause unknown, never inferred from the signal.
import type { JsonValue } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { localDeviceFiles } from "../../src/execution/device-files-node.ts";
import { RUN_CHANNEL } from "../../src/execution/device-files.ts";
import { createRemoteDeviceFiles } from "../../src/execution/remote-device-files.ts";
import type { HandLink } from "../../src/execution/remote-link.ts";

const scope = { id: "scope-run-termination", root: "/" };

function handReplying(value: JsonValue): HandLink {
	return {
		hello: async () => ({ kind: "hello", instance: "hand-1", durable: false, ops: [RUN_CHANNEL] }),
		dispatch: async () => ({
			kind: "settled",
			result: { content: [], details: { file: { ok: true, value } }, isError: false },
		}),
		close: () => undefined,
	};
}

const runOn = (link: HandLink) =>
	createRemoteDeviceFiles(link, scope, () => "exec-1").run({ exe: "git", argv: ["status"], cwd: "/repo" });

describe("remote run termination", () => {
	it("keeps the hand's timed_out for a SIGTERM its own timer sent", async () => {
		const result = await runOn(
			handReplying({ code: null, signal: "SIGTERM", termination: { kind: "timed_out" }, stdout: "", stderr: "" }),
		);
		expect(result.termination).toEqual({ kind: "timed_out" });
	});

	it("keeps signaled for the same SIGTERM from another cause", async () => {
		const result = await runOn(
			handReplying({ code: null, signal: "SIGTERM", termination: { kind: "signaled" }, stdout: "", stderr: "" }),
		);
		expect(result.termination).toEqual({ kind: "signaled" });
	});

	it("leaves the cause unknown for a hand that sends no termination", async () => {
		const result = await runOn(handReplying({ code: null, signal: "SIGTERM", stdout: "", stderr: "" }));
		expect(result.signal).toBe("SIGTERM");
		expect(result.termination).toBeUndefined();
	});

	it("leaves the cause unknown for an unrecognised termination kind", async () => {
		const result = await runOn(
			handReplying({ code: 0, signal: null, termination: { kind: "finished" }, stdout: "", stderr: "" }),
		);
		expect(result.termination).toBeUndefined();
	});
});

describe.skipIf(process.platform === "win32")("fused run termination", () => {
	const node = process.execPath;

	it("reports timed_out when its own timeout stops a live child", async () => {
		const result = await localDeviceFiles().run({
			exe: node,
			argv: ["-e", "setInterval(() => {}, 1000)"],
			cwd: process.cwd(),
			timeoutMs: 50,
		});
		expect(result.signal).toBe("SIGTERM");
		expect(result.termination).toEqual({ kind: "timed_out" });
	});

	it("reports signaled when the child ends on SIGTERM before any timeout", async () => {
		const result = await localDeviceFiles().run({
			exe: node,
			argv: ["-e", "process.kill(process.pid, 'SIGTERM'); setInterval(() => {}, 1000)"],
			cwd: process.cwd(),
			timeoutMs: 60_000,
		});
		expect(result.signal).toBe("SIGTERM");
		expect(result.termination).toEqual({ kind: "signaled" });
	});

	it("reports exited with the child's code", async () => {
		const result = await localDeviceFiles().run({
			exe: node,
			argv: ["-e", "process.exit(3)"],
			cwd: process.cwd(),
			timeoutMs: 60_000,
		});
		expect(result.code).toBe(3);
		expect(result.termination).toEqual({ kind: "exited" });
	});
});
