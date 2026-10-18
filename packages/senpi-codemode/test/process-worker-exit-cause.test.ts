import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnProcessWorker } from "../src/kernels/js/process-worker.ts";

class FakeChild extends EventEmitter {
	readonly written: string[] = [];
	readonly stdin = { write: (chunk: string) => this.written.push(chunk) };
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	kill(): boolean {
		return true;
	}
}

function startWorker(child: FakeChild) {
	const worker = spawnProcessWorker(new URL("file:///kernel/process-entry.js"), {
		cwd: process.cwd(),
		parallelPoolWidth: 1,
		execPath: process.execPath,
		spawn: () => child,
	});
	const errors: Error[] = [];
	worker.onError((error) => errors.push(error));
	const token = String(child.written[0]).trim();
	return { errors, token };
}

const crashLine = (token: string, message: string) =>
	`\nsenpi-kernel-crash ${token} ${JSON.stringify({ name: "Error", message })}\n`;

afterEach(() => {
	vi.useRealTimers();
});

describe("Given a process kernel child that reports its crash cause on stderr", () => {
	it("When its exit is observed before the cause arrives on stderr, then the cell still gets the cause", async () => {
		const child = new FakeChild();
		const { errors, token } = startWorker(child);

		child.emit("exit", null, "SIGKILL");
		child.stderr.write(crashLine(token, "boom-mid-write"));
		child.stderr.end();

		await vi.waitFor(() => expect(errors).toHaveLength(1));
		expect(errors[0]?.message).toBe("boom-mid-write");
	});

	it("When the cause arrived before the exit, then the cell gets the cause as before", async () => {
		const child = new FakeChild();
		const { errors, token } = startWorker(child);

		child.stderr.write(crashLine(token, "boom-before-exit"));
		await vi.waitFor(() => expect(child.stderr.readableLength).toBe(0));
		child.emit("exit", null, "SIGKILL");
		child.stderr.end();

		await vi.waitFor(() => expect(errors).toHaveLength(1));
		expect(errors[0]?.message).toBe("boom-before-exit");
	});

	it("When the child dies without a cause and stderr never ends, then the bare exit is reported after a bounded wait", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const child = new FakeChild();
		const { errors } = startWorker(child);

		child.emit("exit", null, "SIGKILL");
		await Promise.resolve();
		expect(errors).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1_000);

		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toContain("signal");
	});
});
