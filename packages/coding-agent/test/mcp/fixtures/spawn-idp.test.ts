import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({
	spawn: spawnMock,
}));

import { spawnOAuthIdp } from "./spawn-idp.ts";

class MockChildProcess extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly kills: string[] = [];
	pid = 4242;
	exitCode: number | null = null;

	kill(signal = "SIGTERM"): boolean {
		this.kills.push(signal);
		if (signal === "SIGKILL" && this.exitCode === null) {
			this.exitCode = 1;
			queueMicrotask(() => this.emit("exit", this.exitCode, signal));
		}
		return true;
	}
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("spawnOAuthIdp", () => {
	it("kills the child when readiness never arrives", async () => {
		vi.useFakeTimers();
		const child = new MockChildProcess();
		spawnMock.mockReturnValue(child);

		const fixture = spawnOAuthIdp();
		const rejected = expect(fixture).rejects.toThrow(/did not report readiness/);
		await vi.advanceTimersByTimeAsync(4000);
		await vi.advanceTimersByTimeAsync(1000);
		await rejected;
		expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
	});

	it("escalates cleanup from TERM to KILL when the child does not exit", async () => {
		vi.useFakeTimers();
		const child = new MockChildProcess();
		spawnMock.mockImplementation(() => {
			queueMicrotask(() => {
				child.stdout.emit(
					"data",
					Buffer.from(
						`${JSON.stringify({
							url: "http://127.0.0.1:1234",
							mcpUrl: "http://127.0.0.1:1234/mcp",
							pid: child.pid,
						})}\n`,
					),
				);
			});
			return child;
		});

		const fixture = await spawnOAuthIdp();
		const cleanup = fixture.cleanup();
		await vi.advanceTimersByTimeAsync(1000);
		await cleanup;
		expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
	});
});
