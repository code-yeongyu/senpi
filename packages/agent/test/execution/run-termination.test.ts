// senpi#7282: a run's result reports how its process ended as observed (`exited` or `signaled`), and, separately, that
// the spawning side's own timer expired and which signals it then sent. Equal signals can have different causes, so the
// result never claims the timer caused the exit; a hand that predates the field leaves everything unknown.
import { mkdtempSync, readFileSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { localDeviceFiles } from "../../src/execution/device-files-node.ts";
import { RUN_CHANNEL, runTermination } from "../../src/execution/device-files.ts";
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

describe("termination record", () => {
	const none = { expired: false, signalsSent: new Set<string>() };
	const expiredTerm = { expired: true, signalsSent: new Set(["SIGTERM"]) };
	it.each([
		["an exit code with no timer", null, none, { kind: "exited" }],
		["a signal with no timer", "SIGTERM", none, { kind: "signaled" }],
		[
			"a signal after the timer sent the same one",
			"SIGTERM",
			expiredTerm,
			{ kind: "signaled", timeout: { expired: true, signalsSent: ["SIGTERM"] } },
		],
		[
			"an exit code after the timer sent a signal",
			null,
			expiredTerm,
			{ kind: "exited", timeout: { expired: true, signalsSent: ["SIGTERM"] } },
		],
		[
			"a timer that expired but delivered nothing",
			"SIGTERM",
			{ expired: true, signalsSent: new Set<string>() },
			{ kind: "signaled", timeout: { expired: true, signalsSent: [] } },
		],
	] as const)("%s", (_case, signal, timer, expected) => {
		expect(runTermination(signal, timer)).toEqual(expected);
	});
});

describe("remote run termination", () => {
	const reply = (termination: JsonValue | undefined) =>
		handReplying({
			code: null,
			signal: "SIGTERM",
			...(termination === undefined ? {} : { termination }),
			stdout: "",
			stderr: "",
		});

	it("keeps the hand's timer provenance next to the observed signal", async () => {
		const termination = { kind: "signaled", timeout: { expired: true, signalsSent: ["SIGTERM"] } };
		expect((await runOn(reply(termination))).termination).toEqual(termination);
	});

	it("keeps an identical signal from another cause without timer provenance", async () => {
		expect((await runOn(reply({ kind: "signaled" }))).termination).toEqual({ kind: "signaled" });
	});

	it("leaves the cause unknown for a hand that sends no termination", async () => {
		const result = await runOn(reply(undefined));
		expect(result.signal).toBe("SIGTERM");
		expect(result.termination).toBeUndefined();
	});

	it.each([["finished"], ["timed_out"]])("leaves the cause unknown for the unrecognised kind %s", async (kind) => {
		expect((await runOn(reply({ kind }))).termination).toBeUndefined();
	});

	it("drops malformed timer provenance instead of reading it as a timeout", async () => {
		const malformed: JsonValue[] = [
			{ expired: false, signalsSent: [] },
			{ expired: true },
			{ expired: true, signalsSent: [1] },
		];
		for (const timeout of malformed) {
			expect((await runOn(reply({ kind: "signaled", timeout }))).termination).toEqual({ kind: "signaled" });
		}
	});
});

describe.skipIf(process.platform === "win32")("fused run termination", () => {
	const node = process.execPath;

	it("records the expired timer and its SIGTERM next to the observed signal for a hung child", async () => {
		const result = await localDeviceFiles().run({
			exe: node,
			argv: ["-e", "setInterval(() => {}, 1000)"],
			cwd: process.cwd(),
			timeoutMs: 50,
		});
		expect(result.signal).toBe("SIGTERM");
		expect(result.termination).toEqual({ kind: "signaled", timeout: { expired: true, signalsSent: ["SIGTERM"] } });
	});

	// #7308 review: the child survives the timer's SIGTERM and later ends on SIGTERM of its own. The record says what
	// was observed and what the timer did; it does not attribute the exit to the timer.
	it("records a child that survived the timer's SIGTERM and later signalled itself without claiming a timeout", async () => {
		// The marker is written from the handler of the first (the timer's) SIGTERM, before the self-signal: the matching
		// final signal alone would not prove the child survived the timer's.
		const dir = mkdtempSync(join(tmpdir(), "run-termination-survived-"));
		const marker = join(dir, "survived");
		try {
			const result = await localDeviceFiles().run({
				exe: node,
				argv: [
					"-e",
					`process.once("SIGTERM", () => { require("fs").writeFileSync(${JSON.stringify(marker)}, "survived"); setImmediate(() => process.kill(process.pid, "SIGTERM")); }); setInterval(() => {}, 1000)`,
				],
				cwd: process.cwd(),
				timeoutMs: 1_000,
			});
			expect(readFileSync(marker, "utf8")).toBe("survived");
			expect(result.signal).toBe("SIGTERM");
			expect(result.termination).toEqual({ kind: "signaled", timeout: { expired: true, signalsSent: ["SIGTERM"] } });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports signaled without timer provenance when the child ends on SIGTERM before any timeout", async () => {
		const result = await localDeviceFiles().run({
			exe: node,
			argv: ["-e", "process.kill(process.pid, 'SIGTERM'); setInterval(() => {}, 1000)"],
			cwd: process.cwd(),
			timeoutMs: 60_000,
		});
		expect(result.signal).toBe("SIGTERM");
		expect(result.termination).toEqual({ kind: "signaled" });
	});

	// The exact ordering from the #7308 review: the child signals itself and dies before the deadline, but the loop is
	// held so its exit is not yet reaped when the timer comes due; kill() on that zombie succeeds. It is still signaled.
	it.skipIf(process.platform !== "linux")(
		"reports signaled for a child that ended on its own SIGTERM but was not yet reaped at the deadline",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "run-termination-zombie-"));
			const marker = join(dir, "pid");
			const timeoutMs = 1_000;
			// The child publishes its pid atomically (write, then rename); only the final name is acted on, so the
			// watcher never reads a created-but-empty file.
			const watcher = watch(dir, (_event, name) => {
				if (name !== "pid") return;
				watcher.close();
				const pid = readFileSync(marker, "utf8").trim();
				const ready = Date.now() + timeoutMs + 200;
				const giveUp = Date.now() + 10_000;
				// Holding the loop is the point: the child's exit must stay unreaped until the timer is overdue.
				while (Date.now() < ready || !readFileSync(`/proc/${pid}/stat`, "utf8").includes(") Z ")) {
					if (Date.now() > giveUp) throw new Error(`child ${pid} never became an unreaped zombie`);
				}
			});
			try {
				const result = await localDeviceFiles().run({
					exe: node,
					argv: [
						"-e",
						`const fs = require("fs"); fs.writeFileSync(${JSON.stringify(marker + ".tmp")}, String(process.pid)); fs.renameSync(${JSON.stringify(marker + ".tmp")}, ${JSON.stringify(marker)}); process.kill(process.pid, "SIGTERM"); setInterval(() => {}, 1000)`,
					],
					cwd: process.cwd(),
					timeoutMs,
				});
				expect(result.signal).toBe("SIGTERM");
				expect(result.termination).toEqual({ kind: "signaled" });
			} finally {
				watcher.close();
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);

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
