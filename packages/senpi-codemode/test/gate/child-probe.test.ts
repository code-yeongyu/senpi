import { ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import {
	CHILD_HANG_WATCHDOG_MS,
	ChildHangError,
	collectChild,
	waitForChildReady,
	watchChild,
} from "../eval/child-probe.ts";

afterEach(() => vi.useRealTimers());

function spawnHeld(script: string): ChildProcess {
	return spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
}

it.each([
	{ stage: "result", script: 'process.send("ready"); setInterval(() => {}, 1000);' },
	{ stage: "exit", script: 'console.log("{}"); process.send("ready"); setInterval(() => {}, 1000);' },
])("names the $stage stage when a child stops making progress there", async ({ stage, script }) => {
	// Given: a real child that goes silent before its result line, or after it but before exiting.
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const child = spawnHeld(script);
	const watched = watchChild(child, { resultLine: true });
	const outcome = watched.closed.catch((error: unknown) => error);
	try {
		await waitForChildReady(child);
		if (stage === "exit") await watched.resultLine();
		// When: the hang watchdog interval passes with no further progress.
		await vi.advanceTimersByTimeAsync(CHILD_HANG_WATCHDOG_MS);
		// Then: the failure names the stalled stage and the child is killed.
		const error = await outcome;
		expect(error).toBeInstanceOf(ChildHangError);
		expect(error).toMatchObject({ stage });
	} finally {
		watched.dispose();
	}
});

it("keeps a child alive past the watchdog interval while it keeps producing output", async () => {
	// Given: a real child that writes progress whenever it is told to, and only then finishes.
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const child = spawnHeld(
		'process.on("message", (m) => { if (m === "tick") process.stderr.write("."); else { console.log("done"); process.disconnect(); } }); process.send("ready");',
	);
	const stderr = child.stderr;
	if (stderr === null) throw new TypeError("child was spawned without a stderr pipe");
	const watched = watchChild(child, { resultLine: true });
	const outcome = watched.closed.then(
		(value) => ({ kind: "closed", value }),
		(error: unknown) => ({ kind: "error", error }),
	);
	try {
		await waitForChildReady(child);
		// When: three watchdog-sized gaps pass, each broken by real output.
		for (let tick = 0; tick < 3; tick += 1) {
			await vi.advanceTimersByTimeAsync(CHILD_HANG_WATCHDOG_MS - 1_000);
			const progressed = once(stderr, "data");
			child.send("tick");
			await Promise.race([progressed, watched.closed]);
		}
		child.send("finish");
		// Then: the child completes normally instead of being killed as hung.
		await expect(outcome).resolves.toMatchObject({
			kind: "closed",
			value: { code: 0, signal: null, stdout: "done\n", stderr: "..." },
		});
	} finally {
		watched.dispose();
	}
});

it("delivers the result line while the child is still running", async () => {
	// Given: a real child that prints its result and then waits to be released before exiting.
	const child = spawnHeld('console.log("result"); process.once("message", () => process.disconnect());');
	const watched = watchChild(child, { resultLine: true });
	try {
		// When: the result line arrives.
		const line = await watched.resultLine();
		// Then: it is readable before the exit, and the exit still reports the complete output.
		expect(line).toBe("result");
		expect(child.exitCode).toBeNull();
		child.send("release");
		await expect(watched.closed).resolves.toMatchObject({ code: 0, signal: null, stdout: "result\n" });
	} finally {
		watched.dispose();
	}
});

it("trims a trailing carriage return from a CRLF result line", async () => {
	const watched = watchChild(spawnHeld('process.stdout.write("result\\r\\n"); process.exit(0);'), {
		resultLine: true,
	});
	await expect(watched.resultLine()).resolves.toBe("result");
	await expect(watched.closed).resolves.toMatchObject({ code: 0, signal: null });
});

it("rejects the result line when the child exits without writing one", async () => {
	const watched = watchChild(spawnHeld("process.exit(3)"), { resultLine: true });
	await expect(watched.resultLine()).rejects.toThrow(/closed before its result line \(code 3/);
	await expect(watched.closed).resolves.toMatchObject({ code: 3 });
});

it("does not preempt the QA driver's declared 240-second budget", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const child = new ChildProcess();
	vi.spyOn(child, "kill").mockReturnValue(false);
	let settled = false;
	const outcome = collectChild(child).then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	try {
		await vi.advanceTimersByTimeAsync(180_000);
		expect(settled).toBe(false);
	} finally {
		await vi.advanceTimersByTimeAsync(240_000);
		await outcome;
	}
});

it("retains buffered stdout and stderr when its hang watchdog fires", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const child = new ChildProcess();
	vi.spyOn(child, "kill").mockReturnValue(false);
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	child.stdout = stdout;
	child.stderr = stderr;
	const outcome = collectChild(child).catch((error: unknown) => error);
	stdout.write("buffered-output");
	stderr.write("buffered-error");
	await vi.advanceTimersByTimeAsync(240_000);
	const error: unknown = await outcome;
	if (!(error instanceof Error)) throw new TypeError("Watchdog did not reject");
	expect(error.message).toContain("buffered-output");
	expect(error.message).toContain("buffered-error");
});

it("rejects with the spawn failure instead of throwing before error subscription", async () => {
	// Given: a missing executable and an independent observer of the OS failure.
	const child = spawn("senpi-deliberately-missing-probe-command", [], { stdio: ["ignore", "pipe", "pipe"] });
	const failed = once(child, "error");
	// When / Then: the collector returns a rejected promise carrying ENOENT.
	await expect(Promise.resolve().then(() => collectChild(child))).rejects.toMatchObject({ code: "ENOENT" });
	await failed;
});

it("rejects readiness immediately when the child exits before its marker", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const child = spawn(process.execPath, ["-e", "process.exit(1)"], {
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	let error: unknown;
	const readiness = waitForChildReady(child).catch((failure: unknown) => {
		error = failure;
	});
	try {
		await collectChild(child);
		await vi.advanceTimersByTimeAsync(0);
		expect(error).toBeInstanceOf(TypeError);
		await readiness;
	} finally {
		child.removeAllListeners();
	}
});

it.each([1, 2, 3])(
	"waits for a deliberately held child rather than its startup deadline (%s)",
	async () => {
		// Given: an actual child held at an IPC barrier before producing its output.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const child = spawn(
			process.execPath,
			[
				"-e",
				'process.send("ready"); process.once("message", () => { console.log("released"); process.disconnect(); });',
			],
			{ stdio: ["ignore", "pipe", "pipe", "ipc"] },
		);
		const ready = waitForChildReady(child);
		const result = collectChild(child);
		const outcome = result.then(
			(value) => ({ kind: "closed", value }),
			(error: unknown) => ({ kind: "error", error }),
		);
		try {
			await ready;
			// When: startup lasts beyond every old driver deadline without consuming real time.
			await vi.advanceTimersByTimeAsync(61_000);
			child.send("release");
			// Then: the close event still returns complete output, not a SIGKILL.
			await expect(outcome).resolves.toMatchObject({
				kind: "closed",
				value: { code: 0, signal: null, stdout: "released\n" },
			});
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
	},
	180_000,
);
