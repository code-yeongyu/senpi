/**
 * omo#12965: a process can hold more than one copy of the engine's modules in one realm (the bundled CLI next to the
 * SDK graph a plugin imports, a re-evaluated extension, an embedder's second install). Every table one copy writes and
 * another reads is a realm registry, so two copies behave as one. Each case loads the real modules twice: `vi.resetModules()`
 * between the imports gives copy B its own module graph while both share the realm's `globalThis`, which is exactly the
 * two-copy arrangement. Design: approved #12965 class fix, tests T-A, T-B and the T-C payload cases.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { KillGuardRuntime } from "../../src/core/kill-guard/runtime.ts";

const roots: string[] = [];
afterAll(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

async function twoCopies<T>(load: () => Promise<T>): Promise<[T, T]> {
	const a = await load();
	vi.resetModules();
	const b = await load();
	return [a, b];
}

/** The realm's registry under `keyName`, read the way a copy that knows only the key would. */
function registryAt(keyName: string): Record<string, (...args: never[]) => unknown> {
	const value: unknown = Reflect.get(globalThis, Symbol.for(keyName));
	if (typeof value !== "object" || value === null) throw new Error(`no realm registry under ${keyName}`);
	return value as Record<string, (...args: never[]) => unknown>;
}

const decisionModules = async () => ({
	decision: await import("../../src/core/permission-decision.ts"),
	presets: await import("../../src/core/extensions/builtin/permission-system/preset-registry.ts"),
	origin: await import("../../src/core/turn-origin.ts"),
});

interface StubOptions {
	readonly parent?: string;
	readonly named?: () => string | undefined;
	readonly recorded?: string;
	readonly launchFlag?: boolean;
}

function decisionStub(id: string, options: StubOptions = {}) {
	const sessionManager = {
		getSessionId: () => id,
		getEntries: () => [],
		getHeader: () => ({
			type: "session" as const,
			id,
			timestamp: "",
			cwd: "",
			...(options.parent === undefined
				? {}
				: { spawnedBy: { parentSessionId: options.parent, rootSessionId: options.parent, taskId: `${id}-task` } }),
		}),
	};
	return {
		sessionManager,
		namedPreset: options.named ?? (() => undefined),
		launchFlagNamed: () => options.launchFlag ?? false,
		recordedPreset: () => options.recorded,
	};
}

describe("T-A decision sessions and the delegated record scope across two engine copies (omo#12965)", () => {
	it("loads two distinct copies of the decision modules", async () => {
		const [a, b] = await twoCopies(decisionModules);
		expect(a.decision.bindDecisionPreset).not.toBe(b.decision.bindDecisionPreset);
		expect(a.origin.noteRunStart).not.toBe(b.origin.noteRunStart);
	});

	it("(1) a child bound in copy B follows a parent bound in copy A, and A's later change applies at B's next decision", async () => {
		const [a, b] = await twoCopies(decisionModules);
		let parentMode: string | undefined = "full-access";
		const parent = decisionStub("x12965-a1-parent", { named: () => parentMode });
		const child = decisionStub("x12965-a1-child", { parent: "x12965-a1-parent" });
		a.decision.bindDecisionPreset(parent);
		b.decision.bindDecisionPreset(child);

		expect(b.presets.readDecisionPresetOverride(child.sessionManager)).toBe("full-access");
		parentMode = "read-only";
		expect(b.presets.readDecisionPresetOverride(child.sessionManager)).toBe("read-only");
		a.decision.releaseDecisionPreset(parent.sessionManager);
		expect(b.presets.readDecisionPresetOverride(child.sessionManager)).toBe("ask");
		b.decision.releaseDecisionPreset(child.sessionManager);
	});

	it("(2) a parent in a delegated turn yields the delegated value its own copy computes", async () => {
		const [a, b] = await twoCopies(decisionModules);
		const parent = decisionStub("x12965-a2-parent", { recorded: "read-only" });
		const child = decisionStub("x12965-a2-child", { parent: "x12965-a2-parent" });
		a.decision.bindDecisionPreset(parent);
		b.decision.bindDecisionPreset(child);
		const message = {};
		a.origin.markInputTurnOrigin(message, "delegated");
		a.origin.noteUserMessageStart(parent.sessionManager, message);

		expect(b.presets.readDecisionPresetOverride(child.sessionManager)).toBe("read-only");
		a.decision.releaseDecisionPreset(parent.sessionManager);
		b.decision.releaseDecisionPreset(child.sessionManager);
	});

	it("(3) a delegated record entered by copy A whose first run starts a child bound in copy B asks, or uses the recorded mode", async () => {
		const [a, b] = await twoCopies(decisionModules);
		const parent = decisionStub("x12965-a3-parent", { named: () => "full-access" });
		const recorded = decisionStub("x12965-a3-recorded", { parent: "x12965-a3-parent", recorded: "workspace" });
		const unrecorded = decisionStub("x12965-a3-unrecorded", { parent: "x12965-a3-parent" });
		const later = decisionStub("x12965-a3-later", { parent: "x12965-a3-parent" });
		a.decision.bindDecisionPreset(parent);
		for (const child of [recorded, unrecorded, later]) b.decision.bindDecisionPreset(child);

		await a.origin.runInRecordScope("delegated", async () => {
			b.origin.noteRunStart(recorded.sessionManager);
		});
		await a.origin.runInRecordScope("delegated", async () => {
			b.origin.noteRunStart(unrecorded.sessionManager);
			// The record's first run closed its scope: a later run that descends from it is engine work.
			b.origin.noteRunStart(later.sessionManager);
		});

		expect(b.presets.readDecisionPresetOverride(recorded.sessionManager)).toBe("workspace");
		expect(b.presets.readDecisionPresetOverride(unrecorded.sessionManager)).toBe("ask");
		expect(b.presets.readDecisionPresetOverride(later.sessionManager)).toBe("full-access");
		a.decision.releaseDecisionPreset(parent.sessionManager);
		for (const child of [recorded, unrecorded, later]) b.decision.releaseDecisionPreset(child.sessionManager);
	});

	it("(4) a spawnedBy loop across copies asks instead of recursing", async () => {
		const [a, b] = await twoCopies(decisionModules);
		const x = decisionStub("x12965-a4-x", { parent: "x12965-a4-y" });
		const y = decisionStub("x12965-a4-y", { parent: "x12965-a4-x" });
		a.decision.bindDecisionPreset(x);
		b.decision.bindDecisionPreset(y);

		expect(a.presets.readDecisionPresetOverride(x.sessionManager)).toBe("ask");
		expect(b.presets.readDecisionPresetOverride(y.sessionManager)).toBe("ask");
		a.decision.releaseDecisionPreset(x.sessionManager);
		b.decision.releaseDecisionPreset(y.sessionManager);
	});

	it("(5) a release with a record the caller did not bind does not unbind the session", async () => {
		const [a, b] = await twoCopies(decisionModules);
		const parent = decisionStub("x12965-a5-parent", { named: () => "full-access" });
		const child = decisionStub("x12965-a5-child", { parent: "x12965-a5-parent" });
		a.decision.bindDecisionPreset(parent);
		b.decision.bindDecisionPreset(child);

		b.decision.releaseDecisionPreset(parent.sessionManager);
		const sessions = registryAt("@code-yeongyu/senpi/decision-sessions/v1");
		const bound = sessions.get("x12965-a5-parent" as never);
		sessions.release("x12965-a5-parent" as never, Object.freeze({ effectivePreset: () => "ask" }) as never);

		expect(sessions.get("x12965-a5-parent" as never)).toBe(bound);
		expect(b.presets.readDecisionPresetOverride(child.sessionManager)).toBe("full-access");
		a.decision.releaseDecisionPreset(parent.sessionManager);
		b.decision.releaseDecisionPreset(child.sessionManager);
	});

	it("(7) a second session takes an id a live session holds, and the first session's later release leaves it bound", async () => {
		const [a, b] = await twoCopies(decisionModules);
		const first = decisionStub("x12965-a7-parent", { named: () => "read-only" });
		const second = decisionStub("x12965-a7-parent", { named: () => "full-access" });
		const child = decisionStub("x12965-a7-child", { parent: "x12965-a7-parent" });
		a.decision.bindDecisionPreset(first);
		b.decision.bindDecisionPreset(child);
		const sessions = registryAt("@code-yeongyu/senpi/decision-sessions/v1");

		// A second session takes the id while the first is still live; the first one's later release must not unbind it.
		a.decision.bindDecisionPreset(second);
		expect(b.presets.readDecisionPresetOverride(child.sessionManager)).toBe("full-access");
		a.decision.releaseDecisionPreset(first.sessionManager);
		expect(sessions.get("x12965-a7-parent" as never)).toBeDefined();
		expect(b.presets.readDecisionPresetOverride(child.sessionManager)).toBe("full-access");

		a.decision.releaseDecisionPreset(second.sessionManager);
		expect(sessions.get("x12965-a7-parent" as never)).toBeUndefined();
		b.decision.releaseDecisionPreset(child.sessionManager);
	});

	it("(6) a preset name a newer copy returns that this copy does not know asks, and so does a malformed record", async () => {
		const [, b] = await twoCopies(decisionModules);
		const sessions = registryAt("@code-yeongyu/senpi/decision-sessions/v1");
		const newer = Object.freeze({ effectivePreset: () => "turbo-mode" });
		const malformed = Object.freeze({});
		sessions.bind("x12965-a6-newer" as never, newer as never);
		sessions.bind("x12965-a6-malformed" as never, malformed as never);
		const ofNewer = decisionStub("x12965-a6-child-1", { parent: "x12965-a6-newer" });
		const ofMalformed = decisionStub("x12965-a6-child-2", { parent: "x12965-a6-malformed" });
		b.decision.bindDecisionPreset(ofNewer);
		b.decision.bindDecisionPreset(ofMalformed);

		expect(b.presets.readDecisionPresetOverride(ofNewer.sessionManager)).toBe("ask");
		expect(b.presets.readDecisionPresetOverride(ofMalformed.sessionManager)).toBe("ask");
		sessions.release("x12965-a6-newer" as never, newer as never);
		sessions.release("x12965-a6-malformed" as never, malformed as never);
		b.decision.releaseDecisionPreset(ofNewer.sessionManager);
		b.decision.releaseDecisionPreset(ofMalformed.sessionManager);
	});

	it('(payload) a record-scope origin other than "local" is delegated', async () => {
		const [, b] = await twoCopies(decisionModules);
		const scope = registryAt("@code-yeongyu/senpi/turn-origin/v1");
		const delegated = await (scope.run as (origin: unknown, fn: () => Promise<boolean>) => Promise<boolean>)(
			"future-origin",
			async () => b.origin.recordIsDelegated(),
		);
		const local = await (scope.run as (origin: unknown, fn: () => Promise<boolean>) => Promise<boolean>)(
			"local",
			async () => b.origin.recordIsDelegated(),
		);
		expect({ delegated, local }).toEqual({ delegated: true, local: false });
	});
});

describe.skipIf(process.platform === "win32")("T-B kill-guard runtimes across two copies (omo#12965)", () => {
	const load = async () => import("../../src/core/kill-guard/runtime.ts");
	const protectedPids = () => [process.pid];

	it("keeps one runtime per agent dir, a shim dir per agent dir, and the most recently activated holder's runtime active", async () => {
		const [a, b] = await twoCopies(load);
		const first = tempDir("x12965-kg-1-");
		const second = tempDir("x12965-kg-2-");
		const [h1, h2, h3] = [{}, {}, {}];

		const r1 = a.activateKillGuardRuntime({ holder: h1, agentDir: first, protectedPids });
		const r2 = b.activateKillGuardRuntime({ holder: h2, agentDir: first, protectedPids });
		const r3 = b.activateKillGuardRuntime({ holder: h3, agentDir: second, protectedPids });

		expect(r2).toBe(r1);
		expect(r3?.dir.startsWith(second)).toBe(true);
		expect(r1?.dir.startsWith(first)).toBe(true);
		expect(a.activeKillGuardEnvironment({ PATH: "" }).BASH_ENV).toBe(r3?.bashEnv);
		b.releaseKillGuardRuntime(h3);
		expect(a.activeKillGuardEnvironment({ PATH: "" }).BASH_ENV).toBe(r1?.bashEnv);
		a.releaseKillGuardRuntime(h1);
		b.releaseKillGuardRuntime(h2);
		expect(b.activeKillGuardEnvironment({ PATH: "" })).toEqual({});
	});

	it("(payload) an unreadable shared record keeps the guard on with this copy's own record and says so", async () => {
		const [, b] = await twoCopies(load);
		const dir = tempDir("x12965-kg-bad-");
		const runtimes = registryAt("@code-yeongyu/senpi/kill-guard/v1");
		const planter = {};
		(runtimes.activate as (holder: object, agentDir: string, make: () => unknown) => unknown)(planter, dir, () =>
			Object.freeze({ dir: 7 }),
		);
		const warnings: string[] = [];
		const holder = {};
		const runtime: KillGuardRuntime | undefined = b.activateKillGuardRuntime({
			holder,
			agentDir: dir,
			protectedPids,
			warn: (message: string) => warnings.push(message),
		});

		expect(runtime?.dir.startsWith(dir)).toBe(true);
		expect(b.activeKillGuardEnvironment({ PATH: "" }).BASH_ENV).toBe(runtime?.bashEnv);
		expect(warnings).toEqual([expect.stringContaining("shared record unreadable; local record in use")]);
		b.releaseKillGuardRuntime(holder);
		(runtimes.release as (holder: object) => void)(planter);
	});
});

describe("T-B session writers across two copies (omo#12965)", () => {
	const load = async () => import("../../src/core/session-write-reservation.ts");

	it("sees another copy's writer for last-owner cleanup and lists every copy's writers", async () => {
		const [a, b] = await twoCopies(load);
		const path = join(tempDir("x12965-sw-"), "session.jsonl");
		const owner = { getSessionFile: () => path, isPersisted: () => true };
		const self = { getSessionFile: () => path, isPersisted: () => true };
		a.registerSessionWriter(owner);
		b.registerSessionWriter(self);

		expect(b.hasOtherLiveSessionWriter(path, self)).toBe(true);
		expect(b.liveSessionWritePaths().filter((live) => live === path)).toHaveLength(2);
		a.unregisterSessionWriter(owner);
		expect(b.hasOtherLiveSessionWriter(path, self)).toBe(false);
		b.unregisterSessionWriter(self);
	});

	it("(payload) skips a writer that lacks the owner methods", async () => {
		const [, b] = await twoCopies(load);
		const writers = registryAt("@code-yeongyu/senpi/session-writers/v1");
		const malformed = {};
		(writers.register as (owner: object) => void)(malformed);
		const self = { getSessionFile: () => "/x12965/self.jsonl", isPersisted: () => true };
		expect(b.hasOtherLiveSessionWriter("/x12965/self.jsonl", self)).toBe(false);
		expect(b.liveSessionWritePaths()).not.toContain(undefined);
		(writers.unregister as (owner: object) => void)(malformed);
	});

	it("sends every copy's writers through the one installed isolate reservation", async () => {
		const [a, b] = await twoCopies(load);
		const granted: string[] = [];
		a.installSessionWriteReservation((path) => {
			if (path === "/x12965/held-by-another-isolate.jsonl") {
				throw Object.assign(new Error("session_path_in_use"), { code: "session_path_in_use" });
			}
			granted.push(path);
		});

		expect(() => b.reserveSessionWrite("/x12965/held-by-another-isolate.jsonl")).toThrow("session_path_in_use");
		b.reserveSessionWrite("/x12965/free.jsonl");
		expect(granted).toEqual(["/x12965/free.jsonl"]);
		expect(() => b.installSessionWriteReservation(() => {})).toThrow("already installed");
	});
});

describe("T-B file-mutation queue across two copies (omo#12965)", () => {
	const load = async () => import("../../src/core/tools/file-mutation-queue.ts");

	it("makes copy B's mutation of a file wait until copy A releases its slot", async () => {
		const [a, b] = await twoCopies(load);
		expect(a.withFileMutationQueue).not.toBe(b.withFileMutationQueue);
		const dir = tempDir("x12965-mq-");
		const file = join(dir, "file.txt");
		const order: string[] = [];
		const held = await a.acquireFileMutationLock(file);

		const second = b.withFileMutationQueue(file, async () => {
			order.push("b mutates file");
		});
		// B asked for `file` first, so once this later request through B's copy runs, B's mutation of `file` has either
		// run already (a queue per copy: nothing held it) or is waiting behind A's slot (one queue for the realm).
		await b.withFileMutationQueue(join(dir, "other.txt"), async () => {
			order.push("a still holds file");
		});
		held();
		await second;

		expect(order).toEqual(["a still holds file", "b mutates file"]);
	});

	it("fails copy B's waiter when copy A's holder is stuck, and the queue reports the holder and the waiter", async () => {
		const [a, b] = await twoCopies(load);
		const dir = tempDir("x12965-mq-stuck-");
		const file = join(dir, "file.txt");
		const stuck = registryAt("@code-yeongyu/senpi/file-mutation-queue/v1").stuck as () => unknown;
		const held = await a.acquireFileMutationLock(file);
		let ran = false;
		const waiting = b
			.withFileMutationQueue(file, async () => {
				ran = true;
			})
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		// A later request through B's copy has been served, so B's waiter for `file` is queued by now.
		await b.withFileMutationQueue(join(dir, "other.txt"), async () => {});
		expect(stuck()).toEqual({ holders: [], waiters: 1 });

		held.markStuck("x12965-holder-a");

		expect(await waiting).toMatchObject({ code: "file_locked_by_stuck_module", holder: "x12965-holder-a" });
		expect(stuck()).toEqual({ holders: [{ path: file, holder: "x12965-holder-a" }], waiters: 0 });
		await expect(b.acquireFileMutationLock(file)).rejects.toMatchObject({ code: "file_locked_by_stuck_module" });
		expect(ran).toBe(false);

		held();
		await b.withFileMutationQueue(file, async () => {
			ran = true;
		});
		expect(ran).toBe(true);
		expect(stuck()).toEqual({ holders: [], waiters: 0 });
	});
});

describe("T-B kernel-tools contexts across two copies (omo#12965)", () => {
	const load = async () => import("../../src/core/extensions/kernel-tools-context.ts");
	const tools = {
		capabilities: { invokeScope: true },
		describe: async () => [],
		invoke: async () => undefined,
	};

	it("lets copy A's reader see the tools and invoker copy B entered", async () => {
		const [a, b] = await twoCopies(load);
		const seen = b.kernelToolsStorage.run(tools, () =>
			b.kernelToolInvokerStorage.run({ sessionId: "x12965-kt" }, () => ({
				tools: a.kernelToolsStorage.getStore(),
				invoker: a.kernelToolInvokerStorage.getStore(),
			})),
		);
		expect(seen).toEqual({ tools, invoker: { sessionId: "x12965-kt" } });
	});

	it("(payload) reads a store missing its members as absent", async () => {
		const [a, b] = await twoCopies(load);
		const malformed = { capabilities: { invokeScope: true } } as unknown as typeof tools;
		expect(b.kernelToolsStorage.run(malformed, () => a.activeKernelTools())).toBeUndefined();
	});
});
