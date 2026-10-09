import { existsSync } from "node:fs";
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativePtyLoadResult } from "../src/native-loader.ts";
import {
	TerminalSession,
	type TerminalSessionExit,
	type TerminalSessionHandle,
	type TerminalSessionSignal,
} from "../src/session.ts";

const nativeAvailable: NativePtyLoadResult = {
	native: { PtySession: class NativePtySessionPlaceholder {}, version: () => "0.0.0" },
	diagnostic: null,
};

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

/**
 * Fake backend handle that records every delivered signal and only dies when it
 * receives the signal it cannot ignore (SIGKILL by default).
 */
function createFakeHandle(options: { readonly diesOn?: TerminalSessionSignal | null } = {}): {
	readonly handle: TerminalSessionHandle;
	readonly signals: TerminalSessionSignal[];
} {
	const diesOn = options.diesOn === undefined ? "SIGKILL" : options.diesOn;
	const signals: TerminalSessionSignal[] = [];
	let settle: ((exit: TerminalSessionExit) => void) | null = null;
	const exitPromise = new Promise<TerminalSessionExit>((resolve) => {
		settle = resolve;
	});
	const handle: TerminalSessionHandle = {
		write: () => ({ ok: true, note: "fake write" }),
		resize: () => ({ ok: true, note: "fake resize" }),
		kill(signal = "SIGTERM") {
			signals.push(signal);
			if (diesOn !== null && signal === diesOn) {
				settle?.({ backend: "native", exitCode: null, signal, cancelled: true, timedOut: false });
			}
			return { ok: true, note: `fake kill ${signal}` };
		},
		waitExit: async () => await exitPromise,
	};
	return { handle, signals };
}

function fakeBackedSession(handle: TerminalSessionHandle): TerminalSession {
	return new TerminalSession(
		{ command: "fake-command" },
		{ nativeLoadResult: nativeAvailable, createNativeSession: () => handle },
	).start();
}

describe("TerminalSession.kill escalation", () => {
	it("forwards SIGKILL after SIGTERM and stays idempotent for a repeated signal", async () => {
		const { handle, signals } = createFakeHandle();
		const session = fakeBackedSession(handle);

		const term = session.kill("SIGTERM");
		const repeatedTerm = session.kill("SIGTERM");
		const forced = session.kill("SIGKILL");
		const exit = await session.waitExit();

		expect(term.ok).toBe(true);
		expect(repeatedTerm).toMatchObject({ ok: true, idempotent: true });
		expect(forced.ok).toBe(true);
		expect(forced.idempotent).toBeUndefined();
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(exit.cancelled).toBe(true);
	});

	it("reports kill as idempotent once the session has exited", async () => {
		const { handle, signals } = createFakeHandle();
		const session = fakeBackedSession(handle);

		session.kill("SIGKILL");
		await session.waitExit();
		const afterExit = session.kill("SIGKILL");

		expect(afterExit).toMatchObject({ ok: true, idempotent: true });
		expect(signals).toEqual(["SIGKILL"]);
	});
});

describe("TerminalSession.terminate", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("escalates to SIGKILL when the backend ignores SIGTERM and resolves with the exit", async () => {
		vi.useFakeTimers();
		const { handle, signals } = createFakeHandle();
		const session = fakeBackedSession(handle);

		const terminated = session.terminate({ graceMs: 2000, forcedGraceMs: 500 });
		await vi.advanceTimersByTimeAsync(2000);
		const exit = await terminated;

		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(exit).not.toBeNull();
		expect(exit?.signal).toBe("SIGKILL");
		expect(session.exited).toBe(true);
	});

	it("resolves with the graceful exit without escalating when SIGTERM is honored", async () => {
		vi.useFakeTimers();
		const { handle, signals } = createFakeHandle({ diesOn: "SIGTERM" });
		const session = fakeBackedSession(handle);

		const exit = await session.terminate({ graceMs: 2000, forcedGraceMs: 500 });

		expect(signals).toEqual(["SIGTERM"]);
		expect(exit?.signal).toBe("SIGTERM");
	});

	it("resolves null when the process survives both the grace and the forced grace", async () => {
		vi.useFakeTimers();
		const { handle, signals } = createFakeHandle({ diesOn: null });
		const session = fakeBackedSession(handle);

		const terminated = session.terminate({ graceMs: 1000, forcedGraceMs: 200 });
		await vi.advanceTimersByTimeAsync(1200);

		await expect(terminated).resolves.toBeNull();
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
	});
});

const realShellAvailable = process.platform !== "win32" && existsSync("/bin/sh");

describe.skipIf(!realShellAvailable)("terminate against a real SIGTERM-ignoring process", () => {
	it("ends a shell that traps SIGTERM by escalating to SIGKILL", async () => {
		const session = new TerminalSession(
			// `sleep 30` alone would die from the process-group SIGTERM even with the
			// trap installed, so the shell re-sleeps in a loop: only SIGKILL ends it.
			{ command: "/bin/sh", args: ["-c", "trap '' TERM; while :; do sleep 0.2; done"] },
			{ nativeLoadResult: nativeUnavailable, env: { SENPI_PTY_FORCE_PIPE: "1" } },
		);
		session.start();
		expect(session.backend).toBe("pipe-fallback");
		// Genuine OS boundary: the shell must reach `trap` before we signal it.
		await new Promise((resolve) => setTimeout(resolve, 300));

		const exit = await session.terminate({ graceMs: 500, forcedGraceMs: 5000 });

		expect(exit).not.toBeNull();
		expect(exit?.signal).toBe("SIGKILL");
		expect(exit?.cancelled).toBe(true);
		expect(session.exited).toBe(true);
	}, 20_000);
});
