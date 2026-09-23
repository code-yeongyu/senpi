import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { classifyStdin, readPipedStdin } from "../src/utils/piped-stdin.ts";

function createStdin() {
	const stream = new PassThrough() as PassThrough & { unref: () => void };
	stream.unref = vi.fn();
	return stream;
}

async function settled(promise: Promise<string | undefined>) {
	let done = false;
	promise.then(() => {
		done = true;
	});
	await vi.advanceTimersByTimeAsync(0);
	return done;
}

describe("readPipedStdin", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("gives up on a silent non-pipe stdin when the prompt came from arguments", async () => {
		vi.useFakeTimers();
		const stdin = createStdin();
		const onGiveUp = vi.fn();
		const result = readPipedStdin({ hasPromptArgs: true, stdin, kind: "other", graceMs: 1000, onGiveUp });

		await vi.advanceTimersByTimeAsync(999);
		expect(await settled(result)).toBe(false);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBeUndefined();
		expect(onGiveUp).toHaveBeenCalledWith(1000);
		expect(stdin.unref).toHaveBeenCalledOnce();
		expect(stdin.isPaused()).toBe(true);
		expect(stdin.listenerCount("data")).toBe(0);
		expect(stdin.listenerCount("end")).toBe(0);
	});

	test("keeps reading to EOF once a non-pipe stdin starts sending inside the grace window", async () => {
		vi.useFakeTimers();
		const stdin = createStdin();
		const onGiveUp = vi.fn();
		const result = readPipedStdin({ hasPromptArgs: true, stdin, kind: "other", graceMs: 1000, onGiveUp });

		stdin.write("first ");
		await vi.advanceTimersByTimeAsync(5000);
		stdin.end("second\n");

		await expect(result).resolves.toBe("first second");
		expect(onGiveUp).not.toHaveBeenCalled();
	});

	test("waits for EOF on a non-pipe stdin when it is the only prompt source", async () => {
		vi.useFakeTimers();
		const stdin = createStdin();
		const result = readPipedStdin({ hasPromptArgs: false, stdin, kind: "other", graceMs: 1000 });

		await vi.advanceTimersByTimeAsync(5000);
		expect(await settled(result)).toBe(false);
		stdin.end("late prompt");

		await expect(result).resolves.toBe("late prompt");
	});

	test("waits for a slow shell pipe even when the prompt came from arguments", async () => {
		vi.useFakeTimers();
		const stdin = createStdin();
		const result = readPipedStdin({ hasPromptArgs: true, stdin, kind: "pipe", graceMs: 1000 });

		await vi.advanceTimersByTimeAsync(5000);
		expect(await settled(result)).toBe(false);
		stdin.end("build log");

		await expect(result).resolves.toBe("build log");
	});

	test("returns undefined for empty input and for a TTY", async () => {
		const empty = createStdin();
		const emptyResult = readPipedStdin({ hasPromptArgs: true, stdin: empty, kind: "pipe" });
		empty.end("  \n");
		await expect(emptyResult).resolves.toBeUndefined();

		const tty = createStdin();
		await expect(readPipedStdin({ hasPromptArgs: false, stdin: tty, kind: "tty" })).resolves.toBeUndefined();
		expect(tty.listenerCount("data")).toBe(0);
	});
});

describe("classifyStdin", () => {
	test("reports a TTY and a redirected regular file", () => {
		expect(classifyStdin({ ...createStdin(), isTTY: true } as never)).toBe("tty");

		const dir = mkdtempSync(join(tmpdir(), "senpi-stdin-"));
		const path = join(dir, "input.txt");
		writeFileSync(path, "hello");
		const fd = openSync(path, "r");
		try {
			const stdin = Object.assign(createStdin(), { fd });
			expect(classifyStdin(stdin)).toBe("file");
		} finally {
			closeSync(fd);
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
