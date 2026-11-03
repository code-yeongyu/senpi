import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type ConformanceRunner,
	type ConformanceTarget,
	deferred,
	pidGoneWithin,
	within,
	withFixture,
} from "./harness.ts";

const MIB = 1024 * 1024;
/** Starts a background sleep in the command's process group, prints its pid, then waits on it. */
const BACKGROUND_SLEEP = "sleep 30 & echo $!; wait";

function pidFromOutput(onPid: (pid: number) => void): (chunk: Buffer, stream: "stdout" | "stderr") => void {
	let text = "";
	return (chunk, stream) => {
		if (stream !== "stdout") return;
		text += chunk.toString("utf8");
		const match = /^(\d+)\n/.exec(text);
		if (match) onPid(Number(match[1]));
	};
}

export function defineProcessCases(runner: ConformanceRunner, target: ConformanceTarget): void {
	const { describe, it } = runner;
	const skip = target.skipProcess ?? process.platform === "win32";
	if (skip) return;

	describe("process.exec", () => {
		it(
			"exit 0 returns stdout",
			withFixture(target, async ({ ops, ctx, root }) => {
				const result = await ops.process.exec({ command: "echo hi; echo err >&2", cwd: root }, ctx());
				assert.equal(result.exitCode, 0);
				assert.equal(Buffer.from(result.stdout).toString(), "hi\n");
				assert.equal(Buffer.from(result.stderr).toString(), "err\n");
				assert.equal(result.timedOut, false);
			}),
		);
		it(
			"a non-zero exit is reported, not thrown",
			withFixture(target, async ({ ops, ctx }) => {
				const result = await ops.process.exec({ command: "exit 3" }, ctx());
				assert.equal(result.exitCode, 3);
			}),
		);
		it(
			"the child carries the scope token, recorded before spawn",
			withFixture(target, async ({ ops, ctx, stateDir }) => {
				const result = await ops.process.exec(
					{ command: `cat "${join(stateDir, "machine", "scopes")}/$SENPI_MACHINE_SCOPE.json"` },
					ctx(),
				);
				assert.equal(result.exitCode, 0);
				assert.equal(JSON.parse(Buffer.from(result.stdout).toString()).token, result.scopeToken);
			}),
		);
		it(
			"a timeout kills the whole group",
			withFixture(target, async ({ ops, ctx }) => {
				const pid = deferred<number>();
				const result = await ops.process.exec(
					{ command: BACKGROUND_SLEEP, timeoutMs: 500, onOutput: pidFromOutput(pid.resolve) },
					ctx(),
				);
				assert.equal(result.timedOut, true);
				assert.equal(await pidGoneWithin(await pid.promise, 5000), true, "background child survived the timeout");
			}),
		);
		it(
			"stdout above 8 MiB is capped and flagged truncated",
			withFixture(target, async ({ ops, ctx }) => {
				const result = await ops.process.exec({ command: `head -c ${9 * MIB} /dev/zero` }, ctx());
				assert.equal(result.exitCode, 0);
				assert.equal(result.stdoutTruncated, true);
				assert.equal(result.stdout.byteLength, 8 * MIB);
			}),
		);
		it(
			"an abort signal kills the group and leaves no child",
			withFixture(target, async ({ ops, ctx }) => {
				const controller = new AbortController();
				const pid = deferred<number>();
				const running = ops.process.exec(
					{ command: BACKGROUND_SLEEP, onOutput: pidFromOutput(pid.resolve) },
					ctx({ signal: controller.signal }),
				);
				const childPid = await within(pid.promise, 10_000, "the background pid");
				controller.abort();
				const result = await running;
				assert.equal(result.aborted, true);
				assert.equal(await pidGoneWithin(childPid, 5000), true, "background child survived the abort");
			}),
		);
		it(
			"50 concurrent execs all start without queueing",
			withFixture(target, async ({ ops, ctx, base }) => {
				const go = join(base, "go");
				const allStarted = deferred();
				let started = 0;
				const runs = Array.from({ length: 50 }, () =>
					ops.process.exec(
						{
							command: `while [ ! -f "${go}" ]; do sleep 0.05; done; echo done`,
							onSpawn: () => {
								started += 1;
								if (started === 50) allStarted.resolve();
							},
						},
						ctx(),
					),
				);
				// None can finish before `go` exists, so 50 spawns prove nothing waited for a slot.
				await within(allStarted.promise, 20_000, "all 50 execs to spawn");
				await writeFile(go, "");
				const results = await Promise.all(runs);
				assert.equal(results.filter((result) => result.exitCode === 0).length, 50);
			}),
			60_000,
		);
		it(
			"sweep ends the members of a token with HUP/TERM/KILL",
			withFixture(target, async ({ ops, ctx }) => {
				const result = await ops.process.exec({ command: "sleep 30 >/dev/null 2>&1 & echo $!" }, ctx());
				const survivor = Number(Buffer.from(result.stdout).toString().trim());
				assert.equal(await pidGoneWithin(survivor, 0), false, "background child should outlive its shell");
				await ops.process.sweep([result.scopeToken]);
				assert.equal(await pidGoneWithin(survivor, 3000), true);
			}),
		);
	});

	describe("process.spawn through the holder link", () => {
		it(
			"spawn, write, wait for output, kill",
			withFixture(target, async ({ ops, ctx }) => {
				const handle = await ops.process.spawn(
					{ command: "/bin/sh", args: ["-c", "read line; echo got:$line; sleep 30"] },
					ctx(),
				);
				assert.ok(handle.pid > 0);
				assert.equal(ops.process.handle(handle.id), handle);
				assert.equal(ops.process.list("conformance-device").length, 1);
				const effect = await handle.write(Buffer.from("abc\n"));
				assert.equal(effect.acceptedBytes, 4);
				const waited = await handle.wait({ output: "got:abc", timeoutMs: 10_000 });
				assert.equal(waited.reason, "matched");
				assert.equal(waited.status.state, "running");
				await handle.kill();
				assert.equal(handle.status().state, "killed");
				assert.equal(await pidGoneWithin(handle.pid, 5000), true);
				assert.equal((await handle.wait({ timeoutMs: 1000 })).reason, "exited");
			}),
		);
	});
}
