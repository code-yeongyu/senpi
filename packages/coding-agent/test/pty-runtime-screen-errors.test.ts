import { describe, expect, it, vi } from "vitest";

interface RejectionRecord {
	handled: boolean;
}

const pty = vi.hoisted(() => {
	const records: RejectionRecord[] = [];
	const state = { sharedMode: false, sharedAttachCount: 0, feedCalls: 0 };

	// A thenable standing in for a rejected feed/resize promise. It records
	// whether the caller ever attaches a rejection handler; with none, the
	// real promise would become an unhandled rejection and kill the host
	// process (the omo-ai Windows crash behind #837 / #1214).
	const observedRejection = (record: RejectionRecord): Promise<void> => {
		const failure = new Error("write data discarded, use flow control to avoid losing data");
		const thenable = {
			// biome-ignore lint/suspicious/noThenProperty: intentional thenable observing handler attachment
			then(
				_onFulfilled?: ((value: undefined) => unknown) | null,
				onRejected?: ((reason: unknown) => unknown) | null,
			): Promise<void> {
				if (typeof onRejected === "function") {
					record.handled = true;
					state.sharedAttachCount += 1;
					onRejected(failure);
				}
				return Promise.resolve();
			},
			catch(onRejected?: ((reason: unknown) => unknown) | null): Promise<void> {
				return thenable.then(undefined, onRejected);
			},
			finally(onFinally?: (() => void) | null): Promise<void> {
				onFinally?.();
				return Promise.resolve();
			},
		};
		return thenable as unknown as Promise<void>;
	};

	const sharedRecord: RejectionRecord = { handled: false };
	const sharedRejection = observedRejection(sharedRecord);

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

		emit(text: string): void {
			const chunk = new TextEncoder().encode(text);
			for (const listener of this.dataListeners) listener(chunk);
		}
	}

	class TerminalScreen {
		feed(): Promise<void> {
			state.feedCalls += 1;
			if (state.sharedMode) return sharedRejection;
			const record: RejectionRecord = { handled: false };
			records.push(record);
			return observedRejection(record);
		}

		resize(): Promise<void> {
			if (state.sharedMode) return sharedRejection;
			const record: RejectionRecord = { handled: false };
			records.push(record);
			return observedRejection(record);
		}

		dispose(): void {}
	}

	return { TerminalScreen, TerminalSession, records, sessions: [] as TerminalSession[], state };
});

vi.mock("@earendil-works/pi-pty", () => pty);

import { TerminalRuntimeSession } from "../src/core/extensions/builtin/terminal/runtime-session.ts";

function latestSession(): InstanceType<typeof pty.TerminalSession> {
	const session = pty.sessions.at(-1);
	if (!session) throw new Error("Terminal session was not created");
	return session;
}

describe("PTY runtime screen error ownership", () => {
	it("owns screen feed/resize rejections instead of leaking them unhandled", () => {
		pty.state.sharedMode = false;
		const runtime = new TerminalRuntimeSession("screen-error-fixture", {});

		latestSession().emit("flood");
		runtime.resizeScreen(120, 40);

		expect(pty.records).toHaveLength(2);
		expect(pty.records.every((record) => record.handled)).toBe(true);
		expect(runtime.fullOutput()).toBe("flood");
		runtime.dispose();
	});

	it("attaches one rejection handler per distinct coalesced screen promise", () => {
		pty.state.sharedMode = true;
		pty.state.sharedAttachCount = 0;
		const feedCallsBefore = pty.state.feedCalls;
		const runtime = new TerminalRuntimeSession("screen-coalesce-fixture", {});

		latestSession().emit("one");
		latestSession().emit("two");
		latestSession().emit("three");

		expect(pty.state.feedCalls - feedCallsBefore).toBe(3);
		expect(pty.state.sharedAttachCount).toBe(1);
		runtime.dispose();
		pty.state.sharedMode = false;
	});
});
