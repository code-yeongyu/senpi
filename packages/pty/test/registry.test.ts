import { describe, expect, it } from "vitest";
import {
	SessionRegistry,
	SessionRegistryCapacityError,
	type SessionRegistrySession,
	type TrackedDetachedChild,
} from "../src/registry.ts";

class MockTerminalSession implements SessionRegistrySession {
	readonly command: string;
	private exitHandler: (() => void) | null = null;
	private stopped = false;
	private exitedFlag = false;
	private readonly detachedChildren: readonly TrackedDetachedChild[];

	constructor(command: string, detachedChildren: readonly TrackedDetachedChild[] = []) {
		this.command = command;
		this.detachedChildren = detachedChildren;
	}

	get isExited(): boolean {
		return this.exitedFlag;
	}

	get stopCount(): number {
		return this.stopped ? 1 : 0;
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.exit();
	}

	onExit(handler: () => void): () => void {
		this.exitHandler = handler;
		return () => {
			if (this.exitHandler === handler) this.exitHandler = null;
		};
	}

	getTrackedDetachedChildren(): readonly TrackedDetachedChild[] {
		return this.detachedChildren;
	}

	exit(): void {
		if (this.exitedFlag) return;
		this.exitedFlag = true;
		this.exitHandler?.();
	}
}

describe("SessionRegistry", () => {
	it("uses bash_N ids and prunes least-recently-used exited sessions at the default cap", async () => {
		const created: MockTerminalSession[] = [];
		const registry = new SessionRegistry<MockTerminalSession>({
			createSession({ command }) {
				const session = new MockTerminalSession(command);
				created.push(session);
				return session;
			},
		});

		const entries = [];
		for (let index = 0; index < 32; index += 1) {
			entries.push(await registry.create({ command: "bash" }));
		}
		for (let index = 0; index < 9; index += 1) {
			created[index]?.exit();
		}
		registry.get("bash_1");

		for (let index = 0; index < 8; index += 1) {
			await registry.create({ command: "bash" });
		}

		expect(entries[0]?.id).toBe("bash_1");
		expect(registry.size).toBe(32);
		expect(registry.get("bash_1")).toBe(entries[0]);
		expect(registry.get("bash_2")).toBeNull();
		expect(registry.get("bash_10")).toBe(entries[9]);
		expect(registry.list().filter((entry) => entry.session.isExited)).toHaveLength(1);
		const listed = registry.list();
		expect(listed[listed.length - 1]?.id).toBe("bash_40");
	});

	it("rejects creation at the cap when every session is live", async () => {
		let createCalls = 0;
		const registry = new SessionRegistry<MockTerminalSession>({
			maxSessions: 2,
			createSession({ command }) {
				createCalls += 1;
				return new MockTerminalSession(command);
			},
		});

		await registry.create({ command: "bash" });
		await registry.create({ command: "bash" });
		await expect(registry.create({ command: "bash" })).rejects.toBeInstanceOf(SessionRegistryCapacityError);

		expect(createCalls).toBe(2);
		expect(registry.size).toBe(2);
	});

	it("stops all sessions and tracked detached children idempotently", async () => {
		const killed: string[] = [];
		const registry = new SessionRegistry<MockTerminalSession>({
			// Pin the platform so the detached-child kill target is deterministic
			// regardless of the host OS: POSIX kills the negated process group
			// (-201), while win32 has no process groups and kills the raw pid.
			platform: "linux",
			createSession({ command }) {
				return new MockTerminalSession(command, [
					{
						pid: 101,
						processGroupId: 201,
					},
				]);
			},
			killProcess(target, signal) {
				killed.push(`${target}:${signal}`);
			},
		});
		const first = await registry.create({ command: "bash" });
		const second = await registry.create({ command: "bash" });

		await registry.stopAll();
		await registry.stopAll();

		expect(first.session.stopCount).toBe(1);
		expect(second.session.stopCount).toBe(1);
		expect(killed).toEqual(["-201:SIGTERM", "-201:SIGTERM"]);
		expect(registry.list().every((entry) => entry.state === "exited")).toBe(true);
	});

	it("keeps a stopped-but-live session in stopping state until exit is observed", async () => {
		class SlowStopSession implements SessionRegistrySession {
			readonly command = "bash";
			private stopped = false;
			private exitedFlag = false;

			get isExited(): boolean {
				return this.exitedFlag;
			}

			get stopCalled(): boolean {
				return this.stopped;
			}

			stop(): void {
				this.stopped = true;
			}

			exit(): void {
				this.exitedFlag = true;
			}
		}
		const session = new SlowStopSession();
		const registry = new SessionRegistry<SlowStopSession>({
			initialSessions: [{ id: "bash_1", session, command: "bash" }],
		});

		await registry.stop("bash_1");
		const stopping = registry.get("bash_1");
		const stoppingState = stopping?.state;
		const stoppingExitedAt = stopping?.exitedAt;
		session.exit();
		const exited = registry.get("bash_1");

		expect(session.stopCalled).toBe(true);
		expect(stoppingState).toBe("stopping");
		expect(stoppingExitedAt).toBeNull();
		expect(exited?.state).toBe("exited");
		expect(exited?.exitedAt).not.toBeNull();
	});

	it("sweeps exited startup sessions and session-end detached children", async () => {
		const startupExited = new MockTerminalSession("bash", [{ pid: 301 }]);
		const startupLive = new MockTerminalSession("bash");
		startupExited.exit();
		const killed: string[] = [];
		const registry = new SessionRegistry<MockTerminalSession>({
			initialSessions: [
				{ id: "bash_1", session: startupExited, command: "bash" },
				{ id: "bash_2", session: startupLive, command: "bash" },
			],
			killProcess(target, signal) {
				killed.push(`${target}:${signal}`);
			},
		});

		await registry.sweepExited({ remove: true });

		expect(registry.get("bash_1")).toBeNull();
		expect(registry.get("bash_2")?.session).toBe(startupLive);
		expect(killed).toEqual(["301:SIGTERM"]);

		const child: TrackedDetachedChild = { pid: 302 };
		const ended = await registry.create({
			command: "bash",
			session: new MockTerminalSession("bash", [child]),
		});

		ended.session.exit();
		await registry.sweepExited();

		expect(registry.get(ended.id)?.state).toBe("exited");
		expect(killed).toEqual(["301:SIGTERM", "302:SIGTERM"]);
	});

	it("preserves `this` when stopping a session whose waitExit is a class method", async () => {
		// Regression: the registry must invoke waitExit via the session object, not a detached
		// reference, or class-based sessions (e.g. pi-pty TerminalSession) crash on `this`.
		class ThisBoundSession implements SessionRegistrySession {
			readonly command = "bash";
			private stopped = false;
			private exitHandler: (() => void) | null = null;
			get isExited(): boolean {
				return this.stopped;
			}
			stop(): void {
				this.stopped = true;
				this.exitHandler?.();
			}
			waitExit(): Promise<void> {
				// Touching `this` throws a TypeError if called unbound.
				if (this.stopped) return Promise.resolve();
				return Promise.resolve();
			}
			onExit(handler: () => void): () => void {
				this.exitHandler = handler;
				return () => {
					this.exitHandler = null;
				};
			}
		}

		const registry = new SessionRegistry<ThisBoundSession>();
		const entry = await registry.create({ command: "bash", session: new ThisBoundSession() });
		await expect(registry.stop(entry.id)).resolves.toBe(true);
		expect(registry.get(entry.id)?.state).toBe("exited");
	});
});
