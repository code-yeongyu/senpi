import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { watch } from "node:fs";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { admitStartupSession, SESSION_HELD_EXIT_CODE } from "../../../src/cli/session-opening.ts";
import { claimSessionStart, liveSessionHolders } from "../../../src/core/session-holders.ts";
import { encodedSessionId } from "../../../src/core/session-sidecar-store.ts";
import { dropStartClaim } from "../../../src/core/session-start-claim.ts";
import { createInProcessRig } from "../rpc-inprocess-host-support.ts";
import { type CliStart, cliStart } from "./5988-start-support.ts";

// senpi#5988: the start claim taken at admission. It must end with its process however that process ends, must not
// keep a session forever when its start hangs, must not be lost by a slow start that is still running, and must be
// seen by every other opener: a terminal start (which may take it over), and the RPC host.
let root: string;
let file: string;
let id: string;
const started: CliStart[] = [];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "5988-start-claim-"));
	id = randomUUID();
	file = join(root, "shared.jsonl");
	await writeFile(
		file,
		`${JSON.stringify({ type: "session", version: 3, id, cwd: root, timestamp: new Date(0).toISOString() })}\n`,
	);
});

afterEach(async () => {
	vi.useRealTimers();
	await dropStartClaim(id);
	for (const start of started.splice(0)) await start[Symbol.asyncDispose]();
	await rm(root, { recursive: true, force: true });
});

function start(failLoad?: boolean): CliStart {
	const one = cliStart({ root, file, id, ...(failLoad === undefined ? {} : { failLoad }) });
	started.push(one);
	return one;
}

const claimFile = (): string => join(root, "session-holders", encodedSessionId(id), "start.claim");
const holderPids = async (): Promise<number[]> => (await liveSessionHolders(file, id)).map(({ pid }) => pid);

it.each(["SIGTERM", "SIGKILL"] as const)("a start killed with %s while loading leaves no holder", async (signal) => {
	const first = start();
	expect(await first.next()).toMatchObject({ step: "admitted" });
	first.child.kill(signal);
	await first.exited;

	expect(await start().next()).toMatchObject({ step: "admitted" });
});

it("a start whose loading fails holds nothing once it has exited", async () => {
	const first = start(true);
	expect(await first.next()).toMatchObject({ step: "admitted" });
	first.go();
	expect(await first.exited).toBe(1);

	expect(await holderPids()).toEqual([]);
	await expect(stat(claimFile())).rejects.toMatchObject({ code: "ENOENT" });
	expect(await start().next()).toMatchObject({ step: "admitted" });
});

// A frozen process stands for a start that never completes: alive, but it neither refreshes its claim nor holds.
it.skipIf(process.platform === "win32").each(["before", "after"] as const)(
	"an expired claim never yields two writers: the late start publishes %s the next start claims",
	async (order) => {
		const late = start();
		expect(await late.next()).toMatchObject({ step: "admitted" });
		late.child.kill("SIGSTOP");
		const longAgo = new Date(Date.now() - 10 * 60_000);
		await utimes(claimFile(), longAgo, longAgo);

		if (order === "before") {
			late.child.kill("SIGCONT");
			late.go();
			expect(await late.next()).toMatchObject({ step: "holding" });
			const next = start();
			expect(await next.next()).toBeUndefined();
			expect(await next.exited).toBe(SESSION_HELD_EXIT_CODE);
			return;
		}
		const next = start();
		const admitted = await next.next();
		expect(admitted).toMatchObject({ step: "admitted" });
		late.child.kill("SIGCONT");
		late.go();
		expect(await late.next()).toEqual({ step: "refused at hold", pid: late.child.pid, holders: [admitted?.pid] });
		next.go();
		expect(await next.next()).toMatchObject({ step: "holding" });
	},
);

it("a live start keeps its claim past the expiry while it is still loading", async () => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
	expect(await claimSessionStart(file, id)).toBe(true);
	const watcher = watch(claimFile());
	try {
		const refreshed = once(watcher, "change", { signal: AbortSignal.timeout(10_000) });
		await vi.advanceTimersByTimeAsync(6 * 60_000);
		await refreshed;
	} finally {
		watcher.close();
	}

	expect(await holderPids()).toEqual([process.pid]);
});

it.each([
	{ takeOver: true, outcome: "open" },
	{ takeOver: false, outcome: "cancelled" },
] as const)(
	"a terminal start meets a start that only claimed the session: take over $takeOver",
	async ({ takeOver, outcome }) => {
		const first = start();
		const admitted = await first.next();
		expect(admitted).toMatchObject({ step: "admitted" });
		const asked: string[] = [];

		const result = await admitStartupSession(file, {
			canAsk: true,
			confirm: async (question) => {
				asked.push(question);
				return takeOver;
			},
			err: () => {},
		});

		expect(result).toBe(outcome);
		expect(asked).toEqual([expect.stringContaining(`pid ${admitted?.pid}`)]);
		if (takeOver) {
			expect(await first.exited).toBeNull();
			expect(await holderPids()).toEqual([process.pid]);
		} else {
			expect(await holderPids()).toEqual([admitted?.pid]);
		}
	},
);

it("the RPC host refuses to open a session another process is still starting", async () => {
	const first = start();
	const admitted = await first.next();
	expect(admitted).toMatchObject({ step: "admitted" });
	await using rig = createInProcessRig(root);

	expect(await rig.open("client", { sessionPath: file })).toMatchObject({
		success: false,
		error: "session_held",
		errorData: { holders: [{ pid: admitted?.pid }] },
	});
	expect(rig.registry.size).toBe(0);
});
