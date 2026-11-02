import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { digestFileHandle } from "../../../src/core/extensions/builtin/terminal/monitor-file-digest.ts";
import {
	FILE_MONITOR_POLL_MS,
	FileWatchLoop,
} from "../../../src/core/extensions/builtin/terminal/monitor-file-watch.ts";
import {
	MONITOR_LINE_BUFFER_MAX_CHARS,
	MonitorLineBuffer,
} from "../../../src/core/extensions/builtin/terminal/monitor-line-buffer.ts";
import { type MonitorEvent, MonitorRegistry } from "../../../src/core/extensions/builtin/terminal/monitor-registry.ts";

describe("MonitorLineBuffer", () => {
	it("caps the retained tail of a newline-less stream", () => {
		const buffer = new MonitorLineBuffer();
		expect(buffer.append("x".repeat(MONITOR_LINE_BUFFER_MAX_CHARS * 3))).toEqual([]);
		expect(buffer.append("\n")).toEqual(["x".repeat(MONITOR_LINE_BUFFER_MAX_CHARS)]);
	});

	it("splits crlf-terminated lines and strips the carriage return", () => {
		const buffer = new MonitorLineBuffer();
		expect(buffer.append("one\r\ntwo\nthree")).toEqual(["one", "two"]);
		expect(buffer.append("\n")).toEqual(["three"]);
	});
});

describe("FileWatchLoop", () => {
	it("runs no checks while paused and checks immediately on resume", () => {
		vi.useFakeTimers();
		try {
			let checks = 0;
			const loop = new FileWatchLoop(() => {
				checks += 1;
			});
			vi.advanceTimersByTime(FILE_MONITOR_POLL_MS * 4);
			expect(checks).toBe(4);
			loop.pause();
			vi.advanceTimersByTime(FILE_MONITOR_POLL_MS * 10);
			expect(checks).toBe(4);
			loop.resume();
			expect(checks).toBe(5);
			vi.advanceTimersByTime(FILE_MONITOR_POLL_MS * 2);
			expect(checks).toBe(7);
			loop.stop();
			vi.advanceTimersByTime(FILE_MONITOR_POLL_MS * 4);
			expect(checks).toBe(7);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("paused file monitor", () => {
	const dirs: string[] = [];
	afterEach(async () => {
		await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("defers a change made while paused to the resume check", async () => {
		const dir = await mkdtemp(join(tmpdir(), "monitor-bounds-"));
		dirs.push(dir);
		const events: MonitorEvent[] = [];
		const registry = new MonitorRegistry((event) => events.push(event));
		try {
			const target = join(dir, "watched.log");
			await writeFile(target, "initial\n");
			const { id } = await registry.registerFile({
				description: "deferred fire",
				path: target,
				cwd: dir,
				timeoutMs: 60_000,
				event: "modify",
			});
			const activated = Date.now();
			while (!registry.snapshot().some((entry) => entry.id === id)) {
				if (Date.now() - activated > 10_000) throw new Error("file monitor never activated");
				await new Promise((resolve) => setTimeout(resolve, 25));
			}

			registry.pause([id]);
			await writeFile(target, "changed while paused\n");
			registry.resume([id]);

			const deadline = Date.now() + 10_000;
			while (!events.some((event) => event.type === "summary" && event.id === id)) {
				if (Date.now() > deadline) throw new Error("paused-then-resumed monitor never fired");
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		} finally {
			registry.dispose();
		}
	}, 30_000);
});

describe("digestFileHandle", () => {
	it("changes when file content changes", async () => {
		const dir = await mkdtemp(join(tmpdir(), "monitor-digest-"));
		try {
			const target = join(dir, "digest.log");
			await writeFile(target, "before\n");
			const handle = await open(target, "r");
			const first = await digestFileHandle(handle);
			await writeFile(target, "after\n");
			const second = await digestFileHandle(handle);
			await handle.close();
			expect(second).not.toBe(first);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
