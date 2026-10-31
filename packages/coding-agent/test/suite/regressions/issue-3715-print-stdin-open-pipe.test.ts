import { spawn } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import { PIPED_STDIN_SKIP_HINT, pipedStdinOptions } from "../../../src/cli/piped-stdin-options.ts";
import { PIPED_STDIN_GRACE_MS, type PipedStdin, readPipedStdin } from "../../../src/utils/piped-stdin.ts";

const notAFile = () => false;
const aFile = () => true;

function track(promise: Promise<string | undefined>) {
	const state: { settled: boolean; value: string | undefined } = { settled: false, value: undefined };
	void promise.then((value) => {
		state.settled = true;
		state.value = value;
	});
	return state;
}

describe("readPipedStdin (#3715)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test("a silent open pipe with a prompt argument is skipped after the grace window and paused", async () => {
		const stdin = new PassThrough();
		const read = track(readPipedStdin({ stdin, hasPromptArgument: true, forceRead: false, isRegularFile: notAFile }));

		await vi.advanceTimersByTimeAsync(PIPED_STDIN_GRACE_MS - 1);
		expect(read.settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(read).toEqual({ settled: true, value: undefined });
		expect(stdin.isPaused()).toBe(true);
		expect(stdin.listenerCount("data")).toBe(0);
		expect(stdin.listenerCount("end")).toBe(0);
	});

	test("a slow producer whose first byte lands inside the grace window is read to EOF", async () => {
		const stdin = new PassThrough();
		const read = track(readPipedStdin({ stdin, hasPromptArgument: true, forceRead: false, isRegularFile: notAFile }));

		await vi.advanceTimersByTimeAsync(PIPED_STDIN_GRACE_MS - 50);
		stdin.write("first ");
		await vi.advanceTimersByTimeAsync(5_000);
		expect(read.settled).toBe(false);
		stdin.end("second");
		await vi.advanceTimersByTimeAsync(0);
		expect(read).toEqual({ settled: true, value: "first second" });
	});

	test("a producer whose first byte arrives after 1 s (curl | senpi -p prompt) is read", async () => {
		const stdin = new PassThrough();
		const read = track(readPipedStdin({ stdin, hasPromptArgument: true, forceRead: false, isRegularFile: notAFile }));

		await vi.advanceTimersByTimeAsync(1_000);
		expect(read.settled).toBe(false);
		stdin.write("downloaded ");
		await vi.advanceTimersByTimeAsync(10_000);
		stdin.end("body");
		await vi.advanceTimersByTimeAsync(0);
		expect(read).toEqual({ settled: true, value: "downloaded body" });
	});

	test("piped text with a prompt argument still arrives (cat file | senpi -p prompt)", async () => {
		const stdin = new PassThrough();
		const read = track(readPipedStdin({ stdin, hasPromptArgument: true, forceRead: false, isRegularFile: notAFile }));
		stdin.end("piped text\n");
		await vi.advanceTimersByTimeAsync(0);
		expect(read).toEqual({ settled: true, value: "piped text" });
	});

	test("without a prompt argument stdin is the input and is waited on past the grace window", async () => {
		const stdin = new PassThrough();
		const read = track(
			readPipedStdin({ stdin, hasPromptArgument: false, forceRead: false, isRegularFile: notAFile }),
		);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(read.settled).toBe(false);
		stdin.end("late input");
		await vi.advanceTimersByTimeAsync(0);
		expect(read).toEqual({ settled: true, value: "late input" });
	});

	test("an explicit - forces the read even with a prompt argument", async () => {
		const stdin = new PassThrough();
		const read = track(readPipedStdin({ stdin, hasPromptArgument: true, forceRead: true, isRegularFile: notAFile }));

		await vi.advanceTimersByTimeAsync(60_000);
		expect(read.settled).toBe(false);
		stdin.end("forced");
		await vi.advanceTimersByTimeAsync(0);
		expect(read).toEqual({ settled: true, value: "forced" });
	});

	test("a regular file on stdin is read to EOF regardless of the grace window", async () => {
		const stdin = new PassThrough();
		const read = track(readPipedStdin({ stdin, hasPromptArgument: true, forceRead: false, isRegularFile: aFile }));

		await vi.advanceTimersByTimeAsync(60_000);
		expect(read.settled).toBe(false);
		stdin.end("file body");
		await vi.advanceTimersByTimeAsync(0);
		expect(read).toEqual({ settled: true, value: "file body" });
	});

	test("a TTY is never read", async () => {
		const stdin: PipedStdin & PassThrough = Object.assign(new PassThrough(), { isTTY: true });
		await expect(readPipedStdin({ stdin, hasPromptArgument: false, forceRead: false })).resolves.toBeUndefined();
		expect(stdin.listenerCount("data")).toBe(0);
	});

	test("empty input resolves undefined", async () => {
		const stdin = new PassThrough();
		const read = track(
			readPipedStdin({ stdin, hasPromptArgument: false, forceRead: false, isRegularFile: notAFile }),
		);
		stdin.end("  \n");
		await vi.advanceTimersByTimeAsync(0);
		expect(read).toEqual({ settled: true, value: undefined });
	});
});

describe("readPipedStdin in a real process (#3715)", () => {
	const modulePath = fileURLToPath(new URL("../../../src/utils/piped-stdin.ts", import.meta.url));
	const script = `import(${JSON.stringify(modulePath)}).then((m) => m.readPipedStdin({ hasPromptArgument: true, forceRead: false })).then((value) => process.stdout.write(JSON.stringify(value ?? null)))`;

	test("an open pipe nobody writes or closes lets the process finish on its own", { timeout: 15_000 }, async () => {
		const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "-e", script], {
			stdio: ["pipe", "pipe", "inherit"],
		});
		let stdout = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		try {
			const [code] = await once(child, "exit");
			expect(code).toBe(0);
			expect(stdout).toBe("null");
		} finally {
			child.stdin.destroy();
			child.kill("SIGKILL");
		}
	});
});

describe("pipedStdinOptions (#3715)", () => {
	const capture = () => {
		const written: string[] = [];
		return { written, write: (text: string) => written.push(text) };
	};

	test("a positional message or an @file counts as a prompt argument; - forces the read", () => {
		const stderr = capture();
		expect(pipedStdinOptions(parseArgs(["-p", "hi"]), stderr)).toMatchObject({
			hasPromptArgument: true,
			forceRead: false,
		});
		expect(pipedStdinOptions(parseArgs(["-p", "@notes.md"]), stderr)).toMatchObject({ hasPromptArgument: true });
		expect(pipedStdinOptions(parseArgs(["-p"]), stderr)).toMatchObject({
			hasPromptArgument: false,
			forceRead: false,
		});
		expect(pipedStdinOptions(parseArgs(["-p", "-", "hi"]), stderr)).toMatchObject({
			hasPromptArgument: true,
			forceRead: true,
		});
	});

	test("a skipped stdin is reported with exactly one stderr line", async () => {
		vi.useFakeTimers();
		try {
			const stderr = capture();
			const stdin = new PassThrough();
			const read = track(
				readPipedStdin({ ...pipedStdinOptions(parseArgs(["-p", "hi"]), stderr), stdin, isRegularFile: notAFile }),
			);
			await vi.advanceTimersByTimeAsync(PIPED_STDIN_GRACE_MS);
			expect(read).toEqual({ settled: true, value: undefined });
			await vi.advanceTimersByTimeAsync(60_000);
			expect(stderr.written).toEqual([`${PIPED_STDIN_SKIP_HINT}\n`]);
		} finally {
			vi.useRealTimers();
		}
	});

	test("stdin that delivers data is never reported as skipped", async () => {
		const stderr = capture();
		const stdin = new PassThrough();
		const read = readPipedStdin({
			...pipedStdinOptions(parseArgs(["-p", "hi"]), stderr),
			stdin,
			isRegularFile: notAFile,
		});
		stdin.end("data");
		await expect(read).resolves.toBe("data");
		expect(stderr.written).toEqual([]);
	});
});

describe("parseArgs - (#3715)", () => {
	test("a bare - requests the stdin read and is not an unknown option", () => {
		const parsed = parseArgs(["-p", "-", "summarize"]);
		expect(parsed.readStdin).toBe(true);
		expect(parsed.messages).toEqual(["summarize"]);
		expect(parsed.diagnostics).toEqual([]);
	});
});
