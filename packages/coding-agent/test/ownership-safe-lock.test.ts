import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireOwnershipSafeLock, LegacyLockArtifactError } from "../src/modes/rpc/ownership-safe-lock.ts";

const roots: string[] = [];
const children: ChildProcess[] = [];
const childSource = `
  import { acquireOwnershipSafeLock } from ${JSON.stringify(new URL("../src/modes/rpc/ownership-safe-lock.ts", import.meta.url).href)};
  let signalGo = () => {};
  const go = new Promise((resolve) => { signalGo = resolve; });
  // "mark" is echoed on THIS child's stdout, so the parent can order the echo against this
  // child's own later lines instead of racing a sibling process's pipe.
  process.stdin.on("data", (chunk) => {
    for (const raw of String(chunk).split("\\n")) {
      const line = raw.trim();
      if (line === "mark") console.log("MARK");
      else if (line === "go") signalGo();
    }
  });
  console.log("TRYING");
  const lock = await acquireOwnershipSafeLock(process.argv[1]);
  console.log("ACQUIRED");
  if (process.argv[2] === "block") {
    console.log("BLOCKED");
    const end = Date.now() + 2200;
    while (Date.now() < end) {}
    console.log("UNBLOCKED");
  }
  if (process.argv[2] === "hold") await go;
  await lock();
  console.log("RELEASED");
`;

afterEach(async () => {
	for (const childProcess of children.splice(0)) {
		if (childProcess.exitCode === null && childProcess.signalCode === null) {
			childProcess.kill("SIGKILL");
			await new Promise<void>((resolve) => childProcess.once("exit", () => resolve()));
		}
	}
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("ownership-safe-lock", () => {
	it("uses the option shape, persists a regular file, and releases idempotently", async () => {
		const root = await scratch();
		const lockPath = join(root, "target.lock");
		const release = await acquireOwnershipSafeLock(lockPath, {
			retries: { retries: 2, minTimeout: 1, maxTimeout: 2 },
		});
		expect((await stat(lockPath)).isFile()).toBe(true);
		await release();
		await release();
		expect((await stat(lockPath)).isFile()).toBe(true);
	});

	it("rejects a legacy directory without touching it", async () => {
		const root = await scratch();
		const lockPath = join(root, "target.lock");
		await mkdir(lockPath);
		await writeFile(`${lockPath}/legacy`, "untouched");
		await expect(acquireOwnershipSafeLock(lockPath)).rejects.toThrow(LegacyLockArtifactError);
		await expect(acquireOwnershipSafeLock(lockPath)).rejects.toMatchObject({
			code: "ELEGACY_LOCK_ARTIFACT",
			lockPath,
		});
		expect((await stat(lockPath)).isDirectory()).toBe(true);
		expect(await readFile(`${lockPath}/legacy`, "utf8")).toBe("untouched");
	});

	it("serializes real children: the waiter acquires only after the holder releases", async () => {
		const root = await scratch();
		const lockPath = join(root, "target.lock");
		const events: string[] = [];
		const holder = tracked(lockPath, events, "holder", "hold");
		await holder.seen("ACQUIRED");
		const waiter = tracked(lockPath, events, "waiter", "hold");
		// Ordering (not a fixed absence window) is the proof, and both ordered events come
		// from the WAITER's own stdout: while the holder still holds, the parent makes the
		// waiter echo MARK, so MARK strictly precedes any later line from that same pipe.
		// Anchoring on the holder's RELEASED line instead raced two pipes - the holder drops
		// the lock before it prints, so a legitimate waiter could be observed acquiring first
		// and invert the events (observed as CI flake). A non-exclusive mutant still fails
		// deterministically: it prints ACQUIRED before it ever processes the mark.
		await waiter.seen("TRYING");
		waiter.child.stdin?.write("mark\n");
		await waiter.seen("MARK");
		holder.child.stdin?.write("go\n");
		await holder.seen("RELEASED");
		await waiter.seen("ACQUIRED");
		expect(events.indexOf("waiter:ACQUIRED")).toBeGreaterThan(events.indexOf("waiter:MARK"));
	});

	it("releases a killed holder and keeps a blocked event loop exclusive", async () => {
		const root = await scratch();
		const lockPath = join(root, "target.lock");
		const events: string[] = [];
		const holder = tracked(lockPath, events, "holder", "hold");
		await holder.seen("ACQUIRED");
		const waiter = tracked(lockPath, events, "waiter");
		await waiter.seen("TRYING");
		holder.child.kill("SIGKILL");
		await waiter.seen("ACQUIRED");

		const blocked = tracked(lockPath, events, "blocked", "block");
		const blockedAcquired = blocked.seen("ACQUIRED");
		waiter.child.kill("SIGKILL");
		await blockedAcquired;
		const lateWaiter = tracked(lockPath, events, "late");
		const lateAcquired = lateWaiter.seen("ACQUIRED");
		await lateWaiter.seen("TRYING");
		await blocked.seen("UNBLOCKED");
		await lateAcquired;
		expect(events.indexOf("late:ACQUIRED")).toBeGreaterThan(events.indexOf("blocked:UNBLOCKED"));
	});
});

async function scratch(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "senpi-ownership-lock-"));
	roots.push(root);
	return root;
}

function tracked(
	lockPath: string,
	events: string[],
	name: string,
	mode?: string,
): { readonly child: ChildProcess; readonly seen: (wanted: string, timeoutMs?: number) => Promise<void> } {
	const child = spawn(process.execPath, ["-e", childSource, lockPath, mode ?? ""], {
		stdio: ["pipe", "pipe", "inherit"],
	});
	children.push(child);
	let buffer = "";
	const waiters = new Map<string, () => void>();
	child.stdout?.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines.map((value) => value.trim()).filter((value) => value.length > 0)) {
			events.push(`${name}:${line}`);
			waiters.get(line)?.();
			waiters.delete(line);
		}
	});
	return {
		child,
		seen: (wanted, timeoutMs = 10_000) =>
			new Promise<void>((resolve, reject) => {
				if (events.includes(`${name}:${wanted}`)) return resolve();
				const timer = setTimeout(() => reject(new Error(`timed out waiting for ${name}:${wanted}`)), timeoutMs);
				waiters.set(wanted, () => {
					clearTimeout(timer);
					resolve();
				});
			}),
	};
}
