import { Buffer } from "node:buffer";
import process from "node:process";
import { describe, expect, it } from "vitest";
import type { NativePtyLoadResult } from "../src/native-loader.ts";
import {
	TerminalSession,
	type TerminalSessionDependencies,
	type TerminalSessionExit,
	type TerminalSessionHandle,
	type TerminalSessionOperationResult,
} from "../src/session.ts";

const nativeUnavailable: NativePtyLoadResult = {
	native: null,
	diagnostic: {
		code: "native-unavailable",
		runtime: "node",
		host: "test-host",
		attemptedPath: "/missing/senpi_pty.node",
		attemptedPaths: ["/missing/senpi_pty.node"],
		message: "test native unavailable",
	},
};

function nodeSession(script: string, options: { rawTailBytes?: number } = {}): TerminalSession {
	const dependencies: TerminalSessionDependencies = {
		nativeLoadResult: nativeUnavailable,
	};
	return new TerminalSession(
		{
			command: process.execPath,
			args: ["-e", script],
			rawTailBytes: options.rawTailBytes,
		},
		dependencies,
	);
}

function ok(note: string): TerminalSessionOperationResult {
	return { ok: true, note };
}

describe("TerminalSession", () => {
	it("tracks lifecycle, streams onData chunks, and reports exit state for fallback sessions", async () => {
		const session = nodeSession("process.stdout.write('life'); process.exit(4)");
		const chunks: Buffer[] = [];
		const unsubscribe = session.onData((chunk) => chunks.push(chunk));

		expect(session.exitState.status).toBe("not_started");
		session.start();
		expect(session.exitState.status).toBe("running");
		const exit = await session.waitExit();
		unsubscribe();

		expect(Buffer.concat(chunks).toString("utf8")).toBe("life");
		expect(exit).toMatchObject({ backend: "pipe-fallback", exitCode: 4, timedOut: false });
		expect(session.exitState).toEqual({ status: "exited", exit });
	});

	it("keeps a bounded raw-output tail without dropping the total byte count", async () => {
		const session = nodeSession("process.stdout.write('0123456789')", { rawTailBytes: 4 });
		session.start();

		const exit = await session.waitExit();

		expect(exit.exitCode).toBe(0);
		expect(session.rawOutputBytes).toBe(10);
		expect(session.rawTail.toString("utf8")).toBe("6789");
	});

	it("makes double-kill idempotent while preserving a cancelled exit state", async () => {
		const session = nodeSession("setInterval(() => {}, 1000)");
		session.start();

		const firstKill = session.kill();
		const secondKill = session.kill();
		const exit = await session.waitExit();

		expect(firstKill.ok).toBe(true);
		expect(secondKill).toMatchObject({ ok: true, idempotent: true });
		expect(exit.cancelled).toBe(true);
		expect(session.exitState.exit?.cancelled).toBe(true);
	});

	it("wraps injected native sessions and normalizes native exits", async () => {
		const writes: string[] = [];
		const resizes: string[] = [];
		const kills: string[] = [];
		const nativeExit: TerminalSessionExit = {
			backend: "native",
			exitCode: 0,
			signal: null,
			cancelled: false,
			timedOut: false,
		};
		let dataHandler: ((chunk: Buffer) => void) | null = null;
		const handle: TerminalSessionHandle = {
			onData(handler) {
				dataHandler = handler;
				queueMicrotask(() => handler(Buffer.from("native-data")));
				return () => {
					dataHandler = null;
				};
			},
			write(data) {
				writes.push(Buffer.from(data).toString("utf8"));
				return ok("native write");
			},
			resize(cols, rows) {
				resizes.push(`${cols}x${rows}`);
				return ok("native resize");
			},
			kill(signal) {
				kills.push(signal ?? "SIGTERM");
				return ok("native kill");
			},
			waitExit: async () => nativeExit,
		};
		const chunks: Buffer[] = [];
		const session = new TerminalSession(
			{
				command: "native-command",
			},
			{
				nativeLoadResult: {
					native: { PtySession: class NativePtySessionPlaceholder {}, version: () => "0.0.0" },
					diagnostic: null,
				},
				createNativeSession: () => handle,
			},
		);
		session.onData((chunk) => chunks.push(chunk));

		session.start();
		expect(dataHandler).not.toBeNull();
		const write = session.write("input");
		const resize = session.resize(120, 40);
		const kill = session.kill();
		const exit = await session.waitExit();

		expect(session.backend).toBe("native");
		expect(write.ok).toBe(true);
		expect(resize.ok).toBe(true);
		expect(kill.ok).toBe(true);
		expect(writes).toEqual(["input"]);
		expect(resizes).toEqual(["120x40"]);
		expect(kills).toEqual(["SIGTERM"]);
		expect(Buffer.concat(chunks).toString("utf8")).toBe("native-data");
		expect(exit).toEqual({ ...nativeExit, cancelled: true });
		expect(session.rawTail.toString("utf8")).toBe("native-data");
	});
});
