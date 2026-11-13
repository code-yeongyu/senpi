import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

// senpi#6562 review r3: off Linux the session-held admission check reads every holder's identity from ONE
// `ps -axo pid=,lstart=` snapshot. Keys must come from that snapshot too, never from one `ps` per holder.
const spawns = vi.hoisted(() => ({ ps: [] as string[][], tz: [] as unknown[], starts: new Map<number, string>() }));
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		execFile: ((command: string, args: readonly string[], ...rest: unknown[]) => {
			const callback = rest.at(-1);
			if (typeof callback !== "function") throw new Error("execFile without a callback");
			if (command === "ps") {
				spawns.ps.push([...args]);
				const options = rest[0];
				spawns.tz.push(
					typeof options === "object" && options !== null
						? Reflect.get(Reflect.get(options, "env") ?? {}, "TZ")
						: undefined,
				);
				const pidIndex = args.indexOf("-p");
				const output =
					pidIndex >= 0
						? (spawns.starts.get(Number(args[pidIndex + 1])) ?? "")
						: [...spawns.starts].map(([pid, lstart]) => `${pid} ${lstart}`).join("\n");
				queueMicrotask(() => callback(null, `${output}\n`));
			} else if (command === "/usr/sbin/sysctl") {
				queueMicrotask(() => callback(null, "4A1C2B3D-0000-4000-8000-000000000001\n"));
			} else {
				queueMicrotask(() => callback(new Error(`unexpected ${command}`), ""));
			}
			return undefined;
		}) as unknown as typeof actual.execFile,
	};
});

import { encodedSessionId } from "../../../src/core/session-sidecar-store.ts";
import { lstartUtcMs } from "../../../src/utils/process-identity.ts";
import { reclaimLockState } from "../../../src/core/extensions/builtin/terminal/lease-file.ts";
import { processKeyFromStart } from "../../../src/core/extensions/builtin/terminal/process-key.ts";
import { sessionHeldCheck } from "../../../src/modes/rpc/session-held.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const LSTART = "Thu Nov 12 10:00:00 2026";
const children: ChildProcess[] = [];
const dirs: string[] = [];
const platform = Object.getOwnPropertyDescriptor(process, "platform");

afterEach(async () => {
	if (platform !== undefined) Object.defineProperty(process, "platform", platform);
	for (const child of children.splice(0)) child.kill("SIGKILL");
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	spawns.ps.length = 0;
	spawns.tz.length = 0;
	spawns.starts.clear();
});

it("reads three live keyed holders on macOS with one ps snapshot and no ps per holder", async () => {
	Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
	const root = await mkdtemp(join(tmpdir(), "session-held-snapshot-"));
	dirs.push(root);
	const sessionFile = join(root, "session.jsonl");
	await writeFile(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: SESSION_ID, cwd: root })}\n`);
	const holdersDir = join(root, "session-holders", encodedSessionId(SESSION_ID));
	await mkdir(holdersDir, { recursive: true });
	const startMs = lstartUtcMs(LSTART);
	if (startMs === undefined) throw new Error("fixture lstart did not parse");
	const key = await processKeyFromStart(startMs);
	for (let holder = 0; holder < 3; holder += 1) {
		const child = spawn("sleep", ["60"], { stdio: "ignore" });
		children.push(child);
		if (child.pid === undefined) throw new Error("spawn produced no pid");
		spawns.starts.set(child.pid, LSTART);
		await writeFile(
			join(holdersDir, `${child.pid}.json`),
			JSON.stringify({ pid: child.pid, bootAtMs: 1, processStartedAtMs: startMs, processKey: key, cwd: root }),
		);
	}

	const refusal = await sessionHeldCheck()(sessionFile, SESSION_ID).then(
		() => undefined,
		(error: unknown) => error,
	);

	expect({ held: refusal !== undefined, psSpawns: spawns.ps, tz: spawns.tz }).toEqual({
		held: true,
		psSpawns: [["-axo", "pid=,lstart="]],
		tz: ["UTC"],
	});
});

it("parses ps lstart printed under TZ=UTC as UTC, whatever this process's own time zone", () => {
	expect(lstartUtcMs("Sun Nov  1 01:30:00 2026")).toBe(Date.UTC(2026, 10, 1, 1, 30, 0));
});

it("judges a keyed live holder on macOS with one ps under TZ=UTC, deriving the key from the start it read", async () => {
	Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
	const root = await mkdtemp(join(tmpdir(), "reclaim-one-ps-"));
	dirs.push(root);
	const child = spawn("sleep", ["60"], { stdio: "ignore" });
	children.push(child);
	if (child.pid === undefined) throw new Error("spawn produced no pid");
	spawns.starts.set(child.pid, LSTART);
	const startMs = lstartUtcMs(LSTART);
	if (startMs === undefined) throw new Error("fixture lstart did not parse");
	const lock = join(root, "s.lease.lock");
	await writeFile(
		lock,
		JSON.stringify({
			pid: child.pid,
			bootAtMs: 1,
			processStartedAtMs: startMs,
			processKey: await processKeyFromStart(startMs),
		}),
	);

	const state = await reclaimLockState(lock);

	expect({ state: state.state, psSpawns: spawns.ps.length, tz: spawns.tz }).toEqual({
		state: "held",
		psSpawns: 1,
		tz: ["UTC"],
	});
});
