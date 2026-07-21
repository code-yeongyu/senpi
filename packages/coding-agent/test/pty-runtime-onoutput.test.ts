import { describe, expect, it, vi } from "vitest";

const pty = vi.hoisted(() => {
	class TerminalSession {
		backend: string | null = null;
		exited = false;
		exitResult = null;
		private readonly dataListeners = new Set<(chunk: Uint8Array) => void>();

		constructor() {
			pty.sessions.push(this);
		}

		onData(listener: (chunk: Uint8Array) => void): () => void {
			this.dataListeners.add(listener);
			return () => this.dataListeners.delete(listener);
		}

		onExit(): () => void {
			return () => {};
		}

		start(): this {
			return this;
		}

		kill(): void {}

		waitExit(): Promise<void> {
			return new Promise(() => {});
		}

		emit(text: string): void {
			const chunk = new TextEncoder().encode(text);
			for (const listener of this.dataListeners) listener(chunk);
		}
	}

	class TerminalScreen {
		feed(): Promise<void> {
			return Promise.resolve();
		}

		dispose(): void {}
	}

	return { TerminalScreen, TerminalSession, sessions: [] as TerminalSession[] };
});

vi.mock("@earendil-works/pi-pty", () => pty);

import { TerminalRuntimeSession } from "../src/core/extensions/builtin/terminal/runtime-session.ts";
import { createThrottledEmitter } from "../src/core/extensions/builtin/terminal/tools/bash.ts";

function latestSession(): InstanceType<typeof pty.TerminalSession> {
	const session = pty.sessions.at(-1);
	if (!session) throw new Error("Terminal session was not created");
	return session;
}

describe("PTY runtime output subscriptions", () => {
	it("delivers decoded chunks in order, supports unsubscribe, and drops listeners on dispose", () => {
		const runtime = new TerminalRuntimeSession("output-listener-fixture", {});
		const received: string[] = [];
		const unsubscribe = runtime.onOutput((chunk) => received.push(chunk));
		const throwingUnsubscribe = runtime.onOutput(() => {
			throw new Error("listener failure must not break ingest");
		});

		try {
			latestSession().emit("first");
			latestSession().emit(" second");
			unsubscribe();
			latestSession().emit(" ignored");
			expect(received).toEqual(["first", " second"]);
			expect(runtime.fullOutput()).toBe("first second ignored");

			runtime.dispose();
			latestSession().emit(" after dispose");
			expect(received).toEqual(["first", " second"]);
		} finally {
			throwingUnsubscribe();
			runtime.dispose();
		}
	});
});

describe("PTY output update throttle", () => {
	it("coalesces a burst into leading and trailing emissions", () => {
		vi.useFakeTimers();
		const emit = vi.fn();
		const throttle = createThrottledEmitter(emit, 100);

		try {
			throttle.schedule();
			throttle.schedule();
			throttle.schedule();
			expect(emit).toHaveBeenCalledTimes(1);

			vi.advanceTimersByTime(99);
			expect(emit).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(1);
			expect(emit).toHaveBeenCalledTimes(2);
		} finally {
			throttle.dispose();
			vi.useRealTimers();
		}
	});
});
