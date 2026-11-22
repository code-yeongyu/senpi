import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import { type DeliveryResult, sessionResumeDelivery } from "../../../src/cli/schedule-delivery.ts";
import { runDueJobs } from "../../../src/cli/schedule-runner.ts";
import * as opening from "../../../src/cli/session-opening.ts";
import { createScheduledJob, listScheduledJobs } from "../../../src/core/extensions/builtin/schedule/store.ts";
import { foreignSessionHolders } from "../../../src/core/foreign-session-holders.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createSessionManager } from "../../../src/main.ts";
import { startSessionHolder } from "./issue-2951-holder-support.ts";

// senpi#5756: `senpi --session <file>` / `--continue` on a session another live process runs only warned and then
// opened it as a second writer (the startup path of #5744). Startup now refuses before anything opens the session:
// without a person to ask it exits naming the holder; an interactive terminal gets Cancel or Take over.

let root: string;
let sessionFile: string;
let id: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "held-startup-"));
	id = randomUUID();
	sessionFile = join(root, "held.jsonl");
	await writeFile(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id, cwd: root, timestamp: new Date(0).toISOString() })}\n`,
	);
});

afterEach(async () => {
	vi.restoreAllMocks();
	await rm(root, { recursive: true, force: true });
});

class Exited extends Error {
	readonly code: number | undefined;
	constructor(code: number | undefined) {
		super(`exit ${code}`);
		this.code = code;
	}
}

it.each([
	{ args: ["--session", "held.jsonl"], mode: "print" },
	{ args: ["--session", "held.jsonl"], mode: "rpc" },
	{ args: ["--continue"], mode: "json" },
	// vitest's stdin is not a terminal: an interactive run that cannot ask refuses as well.
	{ args: ["--continue"], mode: "interactive" },
] as const)("startup with $args in $mode mode refuses a session another live process holds", async ({ args, mode }) => {
	await using holder = await startSessionHolder(sessionFile, id, root);
	const errors: string[] = [];
	vi.spyOn(console, "error").mockImplementation((line: unknown) => void errors.push(String(line)));
	vi.spyOn(process, "exit").mockImplementation((code) => {
		throw new Exited(code === undefined || code === null ? undefined : Number(code));
	});
	const starting = createSessionManager(parseArgs([...args]), root, root, SettingsManager.inMemory(), mode);
	await expect(starting).rejects.toEqual(new Exited(opening.SESSION_HELD_EXIT_CODE));
	expect(errors.join("\n")).toContain(`pid ${holder.pid}`);
	expect(errors.join("\n")).not.toContain("Concurrent writes may corrupt");
	expect((await foreignSessionHolders(sessionFile, id)).map(({ pid }) => pid)).toEqual([holder.pid]);
});

async function snapshot(file: string) {
	const { ino, mtimeMs } = await stat(file);
	return { bytes: await readFile(file, "utf8"), ino, mtimeMs };
}

// A version-2 header is migrated and rewritten in place by any load, so a startup that loads the held file before
// admitting it changes the other process's transcript even though it then refuses.
async function writeLegacySession(file: string, cwd: string) {
	await writeFile(
		file,
		`${[
			{ type: "session", version: 2, id, cwd, timestamp: new Date(0).toISOString() },
			{
				type: "message",
				id: "a1b2c3d4",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				message: { role: "hookMessage", customType: "note", content: "hi", display: true, timestamp: 0 },
			},
		]
			.map((line) => JSON.stringify(line))
			.join("\n")}\n`,
	);
}

it.each([
	{ name: "--session", args: () => ["--session", sessionFile], cwd: () => root },
	{ name: "--continue", args: () => ["--continue"], cwd: () => root },
	{ name: "--rebind", args: () => ["--rebind", sessionFile], cwd: () => join(root, "elsewhere") },
])("a refused $name startup leaves the held session file untouched", async ({ args, cwd }) => {
	await mkdir(join(root, "elsewhere"));
	await writeLegacySession(sessionFile, root);
	await using holder = await startSessionHolder(sessionFile, id, root);
	const before = await snapshot(sessionFile);
	const errors: string[] = [];
	vi.spyOn(console, "error").mockImplementation((line: unknown) => void errors.push(String(line)));
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(process, "exit").mockImplementation((code) => {
		throw new Exited(code === undefined || code === null ? undefined : Number(code));
	});
	const refusal = await createSessionManager(
		parseArgs(args()),
		cwd(),
		root,
		SettingsManager.inMemory(),
		"print",
	).catch((error: unknown) => error);
	expect(await snapshot(sessionFile)).toEqual(before);
	expect(refusal).toEqual(new Exited(opening.SESSION_HELD_EXIT_CODE));
	expect(errors.join("\n")).toContain(`Not opened: This session is open in another process (pid ${holder.pid}`);
});

// The review probe: the holder is mid-way through an append, so the file ends in a torn line. Opening it for append
// would set that tail aside (truncate + `.torn-*` copy) and could cut an entry the holder is still writing.
it("a refused startup never truncates the torn tail of a holder that is mid-append", async () => {
	await using holder = await startSessionHolder(sessionFile, id, root);
	await appendFile(sessionFile, '{"type":"message","id":"half-writ');
	const before = await snapshot(sessionFile);
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(process, "exit").mockImplementation((code) => {
		throw new Exited(code === undefined || code === null ? undefined : Number(code));
	});
	const starting = createSessionManager(
		parseArgs(["--session", sessionFile]),
		root,
		root,
		SettingsManager.inMemory(),
		"print",
	);
	const refusal = await starting.catch((error: unknown) => error);
	expect(await snapshot(sessionFile)).toEqual(before);
	expect((await readdir(root)).filter((name) => name.includes(".torn-"))).toEqual([]);
	expect(refusal).toEqual(new Exited(opening.SESSION_HELD_EXIT_CODE));
	expect(holder.pid).toBeGreaterThan(0);
});

// Race with the schedule runner: it checks the session is free (deferWhileSessionOpen), then someone opens it before the
// delivery child's own startup admission refuses. That occurrence must wait for the session, not be failed for good.
it.skipIf(process.platform === "win32")(
	"the resume delivery reports a startup refused for a held session as held, not as a failure",
	async () => {
		const delivery = sessionResumeDelivery(
			{ command: "/bin/sh", args: ["-c", `exit ${opening.SESSION_HELD_EXIT_CODE}`] },
			30_000,
		);
		const result = await delivery({
			type: "scheduled_prompt",
			id: "sch_000000000001",
			sessionId: id,
			sessionFile,
			cwd: root,
			prompt: "p",
			message: "p",
			dueAt: 0,
			firedAt: 0,
			everyMs: null,
			fireCount: 1,
		});
		expect(result).toMatchObject({ ok: false, sessionHeld: true });
	},
);

it.each([null, 3_600_000])(
	"a delivery refused because the session is held defers the occurrence (everyMs %s)",
	async (everyMs) => {
		const dir = join(root, "schedule");
		const t0 = Date.parse("2026-09-27T12:00:00Z");
		const job = await createScheduledJob(
			dir,
			{ sessionId: id, sessionFile, cwd: root, prompt: "p", dueAt: t0, everyMs },
			t0,
		);
		const held: DeliveryResult = { ok: false, error: "session is open elsewhere", sessionHeld: true };
		const result = await runDueJobs({
			dir,
			now: () => t0 + 1_000,
			deliver: async () => held,
			owner: { pid: 101, processStartedAtMs: 1_000 },
			runners: async () => [],
		});
		expect(result.events).toEqual([expect.objectContaining({ event: "deferred", id: job.id })]);
		const { jobs } = await listScheduledJobs(dir);
		expect(
			jobs.map(({ state, job: listed }) => ({ state, dueAt: listed.dueAt, fireCount: listed.fireCount })),
		).toEqual([{ state: "pending", dueAt: t0, fireCount: 0 }]);
	},
);

it("startup opens the session once its holder has exited", async () => {
	const holder = await startSessionHolder(sessionFile, id, root);
	await holder.stop();
	const manager = await createSessionManager(
		parseArgs(["--session", "held.jsonl"]),
		root,
		root,
		SettingsManager.inMemory(),
		"print",
	);
	expect(manager.getSessionId()).toBe(id);
});

it.each([
	{ answer: false, expected: "cancelled" },
	{ answer: true, expected: "open" },
] as const)(
	"an interactive startup asks before opening a held session: take over = $answer",
	async ({ answer, expected }) => {
		await using holder = await startSessionHolder(sessionFile, id, root);
		const asked: string[] = [];
		const errors: string[] = [];
		const result = await opening.admitStartupSession(sessionFile, {
			canAsk: true,
			confirm: async (question) => {
				asked.push(question);
				return answer;
			},
			err: (line) => void errors.push(line),
		});
		expect(result).toBe(expected);
		expect(asked).toHaveLength(1);
		expect(asked[0]).toContain(`pid ${holder.pid}`);
		const holders = (await foreignSessionHolders(sessionFile, id)).map(({ pid }) => pid);
		if (answer) {
			expect(holders).toEqual([]);
		} else {
			expect(holders).toEqual([holder.pid]);
			expect(errors.join("\n")).toContain(`pid ${holder.pid}`);
		}
	},
);

it.each([{ host_instance: "h-1" }, { unproven: true as const }])(
	"take-over is not offered at startup for a holder it cannot stop safely: %o",
	async (extra) => {
		const confirm = vi.fn(async () => true);
		const errors: string[] = [];
		const result = await opening.admitStartupSession(sessionFile, {
			canAsk: true,
			confirm,
			err: (line) => void errors.push(line),
			lookup: async () => ({ holders: [{ pid: 4242, cwd: root, ...extra }] }),
		});
		expect(result).toBe("refused");
		expect(confirm).not.toHaveBeenCalled();
		expect(errors.join("\n")).toContain("pid 4242");
	},
);

it("a failed holder lookup stays advisory at startup", async () => {
	const errors: string[] = [];
	const result = await opening.admitStartupSession(sessionFile, {
		canAsk: false,
		confirm: async () => true,
		err: (line) => void errors.push(line),
		lookup: async () => ({ lookupFailed: true }),
	});
	expect(result).toBe("open");
	expect(errors).toHaveLength(1);
});
