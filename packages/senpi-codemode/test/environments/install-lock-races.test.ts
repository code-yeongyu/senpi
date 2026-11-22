import { spawnSync } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type Fs = typeof import("node:fs/promises");
type Hook = (path: string, content: string) => Promise<void>;

type FsHookSlot = { onRead: Hook | undefined; real: Fs | undefined };
const fsHook: FsHookSlot = vi.hoisted((): FsHookSlot => ({ onRead: undefined, real: undefined }));

function realFs(): Fs {
	const real = fsHook.real;
	if (real === undefined) throw new Error("the node:fs/promises mock has not captured the real module yet");
	return real;
}

// Every read the lock makes passes through onRead, so a test can act as another waiter at that exact point.
vi.mock("node:fs/promises", async (importOriginal) => {
	const real = await importOriginal<Fs>();
	fsHook.real = real;
	const readFile = async (...args: Parameters<Fs["readFile"]>) => {
		const content = await real.readFile(...args);
		if (fsHook.onRead !== undefined) await fsHook.onRead(String(args[0]), String(content));
		return content;
	};
	return { ...real, default: { ...real, readFile }, readFile };
});

const { withRootLock } = await import("../../src/environments/install-lock.ts");

const roots: string[] = [];

afterEach(async () => {
	vi.useRealTimers();
	fsHook.onRead = undefined;
	for (const root of roots.splice(0)) await fsHook.real?.rm(root, { recursive: true, force: true });
});

function exitedPid(): number {
	return spawnSync(process.execPath, ["-e", "0"]).pid ?? 999_999;
}

async function publishLock(base: string, name: string, content: string): Promise<void> {
	const fs = realFs();
	const temp = join(base, `test-temp-${crypto.randomUUID()}`);
	await fs.writeFile(temp, content);
	await fs.link(temp, join(base, name)).catch(() => undefined);
	await fs.rm(temp, { force: true });
}

describe("Given a waiter that judged the root lock stale", () => {
	it("When other waiters replace it with live locks before this waiter acts, then no live lock is ever deleted", async () => {
		const fs = realFs();
		const base = await fs.mkdtemp(join(tmpdir(), "senpi-lock-race-"));
		roots.push(base);
		const lock = join(base, ".install.lock");
		const stale = JSON.stringify({ pid: exitedPid(), host: hostname(), nonce: "stale" });
		const replacement = JSON.stringify({ pid: process.pid, host: hostname(), nonce: "replacement" });
		const latecomer = JSON.stringify({ pid: process.pid, host: hostname(), nonce: "latecomer" });
		await fs.writeFile(lock, stale);
		let replaced = false;
		let latecomerLinked = false;
		fsHook.onRead = async (path, content) => {
			// Another waiter has just reaped the stale lock and published its own, live one.
			if (!replaced && path === lock && content === stale) {
				replaced = true;
				await fs.rm(lock, { force: true });
				await publishLock(base, ".install.lock", replacement);
				return;
			}
			// The live lock is being read somewhere other than its own path: a third waiter links into the gap.
			if (!latecomerLinked && path !== lock && content === replacement) {
				latecomerLinked = true;
				await publishLock(base, ".install.lock", latecomer);
			}
		};

		const entered = await withRootLock(base, async () => "entered", AbortSignal.timeout(1_500)).catch(() => "waited");

		const onDisk = await fs.readFile(lock, "utf8").catch(() => "<none>");
		expect(entered).toBe("waited");
		expect(onDisk).toBe(replacement);
		expect((await fs.readdir(base)).filter((name) => name.startsWith(".install.lock.reap."))).toEqual([]);
	});
});

describe("Given two waiters that find the same stale lock", () => {
	it("When both try to reap it, then only the waiter holding the reap claim removes it and they hold the lock one at a time", async () => {
		const fs = realFs();
		const base = await fs.mkdtemp(join(tmpdir(), "senpi-lock-claim-"));
		roots.push(base);
		const lock = join(base, ".install.lock");
		const stale = JSON.stringify({ pid: exitedPid(), host: hostname(), nonce: "stale" });
		await fs.writeFile(lock, stale);
		let staleReads = 0;
		let secondRead = (): void => undefined;
		const bothJudged = new Promise<void>((resolve) => {
			secondRead = resolve;
		});
		fsHook.onRead = async (path, content) => {
			if (path !== lock || content !== stale) return;
			staleReads += 1;
			// Both waiters judge the lock stale before either claims it.
			if (staleReads === 1) await bothJudged;
			if (staleReads === 2) secondRead();
			// A fourth read of the stale lock is a second waiter re-reading it under its own claim: hold it
			// until the first waiter has replaced the lock, which is exactly when a removal by path would hit it.
			if (staleReads === 4) {
				for (let turn = 0; turn < 1_000; turn++) {
					if ((await fs.readFile(lock, "utf8").catch(() => stale)) !== stale) return;
					await new Promise((resolve) => setImmediate(resolve));
				}
			}
		};
		let inside = 0;
		let peak = 0;
		const holder = async () => {
			inside += 1;
			peak = Math.max(peak, inside);
			// Hold long enough, in filesystem round trips, for the other waiter to act on what it read.
			for (let trip = 0; trip < 200; trip++) await fs.stat(base);
			inside -= 1;
		};

		await Promise.all([
			withRootLock(base, holder, AbortSignal.timeout(10_000)),
			withRootLock(base, holder, AbortSignal.timeout(10_000)),
		]);

		expect(peak).toBe(1);
	});
});

describe("Given a stale lock that a live waiter is reaping", () => {
	it("When another waiter finds it, then that waiter waits quietly instead of re-reading the lock in a loop", async () => {
		const fs = realFs();
		const base = await fs.mkdtemp(join(tmpdir(), "senpi-lock-quiet-"));
		roots.push(base);
		const lock = join(base, ".install.lock");
		await fs.writeFile(lock, JSON.stringify({ pid: exitedPid(), host: hostname(), nonce: "stale" }));
		await fs.writeFile(
			join(base, ".install.lock.reap.stale.0"),
			JSON.stringify({ pid: process.pid, host: hostname(), nonce: "live" }),
		);
		let lockReads = 0;
		fsHook.onRead = async (path) => {
			if (path === lock) lockReads += 1;
		};
		const controller = new AbortController();
		// The periodic recheck is time-driven; with it frozen, only a waiter that loops adds reads.
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

		const waiting = withRootLock(base, async () => "entered", controller.signal).catch((error: unknown) => error);
		// Let the waiter make as much filesystem progress as 1,000 round trips of our own.
		for (let trip = 0; trip < 1_000; trip++) await fs.stat(base);
		const readsWhileWaiting = lockReads;
		controller.abort();
		await waiting;
		vi.useRealTimers();

		expect(readsWhileWaiting).toBeLessThan(10);
	});
});

describe("Given a waiter inspecting a reap claim", () => {
	it("When its install is cancelled during that inspection, then it stops promptly instead of waiting for the lock", async () => {
		const fs = realFs();
		const base = await fs.mkdtemp(join(tmpdir(), "senpi-lock-abort-"));
		roots.push(base);
		await fs.writeFile(
			join(base, ".install.lock"),
			JSON.stringify({ pid: exitedPid(), host: hostname(), nonce: "stale" }),
		);
		const claim = join(base, ".install.lock.reap.stale.0");
		await fs.writeFile(claim, JSON.stringify({ pid: process.pid, host: hostname(), nonce: "live" }));
		const controller = new AbortController();
		fsHook.onRead = async (path) => {
			if (path === claim) controller.abort(new Error("install cancelled"));
		};

		const outcome = await Promise.race([
			withRootLock(base, async () => "entered", controller.signal).then(
				() => "entered",
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			),
			new Promise<string>((resolve) => setTimeout(() => resolve("still waiting"), 2_000).unref()),
		]);

		expect(outcome).toBe("install cancelled");
	});
});
