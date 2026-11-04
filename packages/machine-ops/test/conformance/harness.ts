import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LIMITS } from "../../src/limits.ts";
import type { Limits, MachineOps, OpContext, PolicyHooks } from "../../src/types.ts";

/** The subset of a test runner the suite needs; vitest and bun:test both satisfy it. */
export interface ConformanceRunner {
	describe(name: string, fn: () => void): void;
	it(name: string, fn: () => Promise<void>, timeoutMs?: number): void;
}

/** How the suite obtains the implementation under test. */
export interface ConformanceTarget {
	/** Create a fresh instance whose state lives under `stateDir`. */
	create(stateDir: string): MachineOps | Promise<MachineOps>;
	/** Release what `create` started (holder links, sessions). */
	dispose?(ops: MachineOps): Promise<void>;
	/** Skip process cases (no POSIX shell on this platform). Default: skipped on win32. */
	skipProcess?: boolean;
}

export interface Fixture {
	readonly base: string;
	/** Scope root, containing `inside.txt`, `dir/a.ts`, and `escape` -> `outside`. */
	readonly root: string;
	/** Sibling of `root` holding `secret.txt`. */
	readonly outside: string;
	readonly stateDir: string;
	readonly ops: MachineOps;
	ctx(overrides?: { policy?: PolicyHooks; signal?: AbortSignal; limits?: Partial<Limits> }): OpContext;
	cleanup(): Promise<void>;
}

export const INSIDE_TEXT = "hello world\nsecond line\n";
export const SECRET_TEXT = "secret\n";
export const READ_LIMIT = DEFAULT_LIMITS.readMaxBytes;

export async function createFixture(target: ConformanceTarget): Promise<Fixture> {
	const base = await realpath(await mkdtemp(join(tmpdir(), "machine-ops-conformance-")));
	const root = join(base, "root");
	const outside = join(base, "outside");
	const stateDir = join(base, "state");
	await mkdir(join(root, "dir"), { recursive: true });
	await mkdir(outside, { recursive: true });
	await writeFile(join(root, "inside.txt"), INSIDE_TEXT);
	await writeFile(join(root, "dir", "a.ts"), "export const a = 1;\n");
	await writeFile(join(outside, "secret.txt"), SECRET_TEXT);
	await symlink(outside, join(root, "escape"), "dir");
	const ops = await target.create(stateDir);
	return {
		base,
		root,
		outside,
		stateDir,
		ops,
		ctx(overrides) {
			return {
				scope: { id: "conformance", root },
				principal: { kind: "remote-device", id: "conformance-device" },
				signal: overrides?.signal ?? new AbortController().signal,
				limits: { ...DEFAULT_LIMITS, ...overrides?.limits },
				policy: overrides?.policy ?? {},
			};
		},
		async cleanup() {
			await target.dispose?.(ops);
			await rm(base, { recursive: true, force: true });
		},
	};
}

/** Run `fn` against a fresh fixture and always clean it up. */
export function withFixture(target: ConformanceTarget, fn: (fixture: Fixture) => Promise<void>): () => Promise<void> {
	return async () => {
		const fixture = await createFixture(target);
		try {
			await fn(fixture);
		} finally {
			await fixture.cleanup();
		}
	};
}

/** A file one byte above the machine-path read limit. */
export async function writeOversizedFile(path: string): Promise<void> {
	await writeFile(path, Buffer.alloc(READ_LIMIT + 1, 0x61));
}

/** A promise with its resolver, for event-driven waits. */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

/** Race `promise` against a deadline so a missing event fails the case instead of hanging it. */
export async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for ${what}`)), ms);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function processGone(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

/** Whether `pid` is gone within `ms`. Process death has no event to await, so this is a bounded poll. */
export async function pidGoneWithin(pid: number, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	for (;;) {
		if (processGone(pid)) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
