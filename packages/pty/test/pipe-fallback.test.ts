import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { NativePtyLoadResult } from "../src/native-loader.ts";
import {
	createPipeFallbackSession,
	isPipeFallbackForced,
	PipeFallbackSession,
	shouldUsePipeFallback,
} from "../src/pipe-fallback.ts";

function nodeSession(script: string, options: { timeoutMs?: number } = {}): PipeFallbackSession {
	const session = new PipeFallbackSession({
		command: process.execPath,
		args: ["-e", script],
		timeoutMs: options.timeoutMs,
	});
	session.start();
	return session;
}

async function collectOutput(session: PipeFallbackSession): Promise<{ output: string; exitCode: number | null }> {
	const chunks: Buffer[] = [];
	session.onData((chunk) => chunks.push(chunk));
	const exit = await session.waitExit();
	return { output: Buffer.concat(chunks).toString("utf8"), exitCode: exit.exitCode };
}

describe("PipeFallbackSession", () => {
	it("runs a command through child_process pipes, streams output, and reports the exit code", async () => {
		const session = nodeSession(`
			setTimeout(() => {
				process.stdout.write("stdout-ok\\n");
				process.stderr.write("stderr-ok\\n");
				process.exit(7);
			}, 10);
		`);

		const result = await collectOutput(session);

		expect(result.output).toContain("stdout-ok");
		expect(result.output).toContain("stderr-ok");
		expect(result.exitCode).toBe(7);
	});

	it("selects pipe fallback when SENPI_PTY_FORCE_PIPE=1 even if native is available", async () => {
		const nativeLoadResult: NativePtyLoadResult = { native: { PtySession: class PtySession {} }, diagnostic: null };

		expect(isPipeFallbackForced({ SENPI_PTY_FORCE_PIPE: "1" })).toBe(true);
		expect(shouldUsePipeFallback(nativeLoadResult, { SENPI_PTY_FORCE_PIPE: "1" })).toBe(true);

		const previous = process.env.SENPI_PTY_FORCE_PIPE;
		process.env.SENPI_PTY_FORCE_PIPE = "1";
		try {
			const session = createPipeFallbackSession({
				command: process.execPath,
				args: ["-e", "process.stdout.write('forced-pipe')"],
			});
			const result = await collectOutput(session);
			expect(result.output).toBe("forced-pipe");
			expect(session.note).toContain("pipe fallback");
		} finally {
			if (previous === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
			else process.env.SENPI_PTY_FORCE_PIPE = previous;
		}
	});

	it("reports resize as a clear not-PTY no-op while the session survives", async () => {
		const session = nodeSession(`
			setTimeout(() => {
				process.stdout.write("after-resize");
				process.exit(0);
			}, 25);
		`);

		const resize = session.resize(132, 43);
		const result = await collectOutput(session);

		expect(resize.ok).toBe(false);
		expect(resize.note).toContain("not a PTY");
		expect(result.output).toBe("after-resize");
		expect(result.exitCode).toBe(0);
	});

	it("writes to a live stdin pipe and rejects writes after exit with an informative note", async () => {
		const session = nodeSession(`
			process.stdin.once("data", (chunk) => {
				process.stdout.write("input:" + chunk.toString("utf8"));
				process.exit(0);
			});
		`);
		const chunks: Buffer[] = [];
		session.onData((chunk) => chunks.push(chunk));

		const write = session.write("hello\n");
		const exit = await session.waitExit();
		const afterExitWrite = session.write("late");

		expect(write.ok).toBe(true);
		expect(Buffer.concat(chunks).toString("utf8")).toBe("input:hello\n");
		expect(exit.exitCode).toBe(0);
		expect(afterExitWrite.ok).toBe(false);
		expect(afterExitWrite.note).toContain("exited");
	});

	it("surfaces malformed command spawn failures without pretending output success", async () => {
		const session = new PipeFallbackSession({
			command: "definitely-not-a-senpi-command",
			args: ["--version"],
		});
		session.start();

		const exit = await session.waitExit();

		expect(exit.exitCode).toBeNull();
		expect(exit.error?.code).toBe("spawn_error");
		expect(exit.error?.message).toContain("definitely-not-a-senpi-command");
	});

	it("does not allow stale exited sessions to be restarted", async () => {
		const session = nodeSession("process.exit(0)");
		await session.waitExit();

		expect(() => session.start()).toThrow(/Cannot restart exited pipe fallback session/);
	});

	it("preserves a non-zero exit code even when output claims success", async () => {
		const session = nodeSession("process.stdout.write('SUCCESS\\n'); process.exit(3)");
		const result = await collectOutput(session);

		expect(result.output).toContain("SUCCESS");
		expect(result.exitCode).toBe(3);
	});

	it("times out a hung command when timeoutMs is supplied", async () => {
		const session = nodeSession("setInterval(() => {}, 1000)", { timeoutMs: 30 });

		const exit = await session.waitExit();

		expect(exit.timedOut).toBe(true);
		expect(exit.exitCode).toBeNull();
		await delay(5);
		expect(session.write("late").ok).toBe(false);
	});
});
