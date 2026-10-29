// code-yeongyu/oh-my-openagent#10091: a handoff drain hands a session to the next generation only by a strict
// transfer. These pin the predecessor's half: a session parks only when proven quiet, a retained session's park
// record is durable before anything is torn down, new work for a session sealed for its transfer is refused
// explicitly, and an explicit close that races the transfer wins.
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcCommand } from "../../../src/modes/rpc/rpc-types.ts";
import { opened } from "../rpc-inprocess-host-metrics.ts";
import { createInProcessRig } from "../rpc-inprocess-host-support.ts";

const scratchDirs: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const dir of scratchDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-10091-"));
	scratchDirs.push(dir);
	return dir;
}

interface RigOptions {
	readonly pendingPrompts?: () => readonly Promise<unknown>[];
	readonly parkedDir?: string;
	readonly now?: () => number;
	readonly retain?: boolean;
}

async function drainRig(options: RigOptions = {}) {
	const dir = await scratch();
	const exited = Promise.withResolvers<void>();
	const routed: string[] = [];
	const rig = createInProcessRig(
		dir,
		{
			onEmptyExit: () => exited.resolve(),
			...(options.parkedDir !== undefined ? { handoverParkedDir: options.parkedDir } : {}),
			...(options.now !== undefined ? { now: options.now } : {}),
		},
		async (command: RpcCommand) => {
			routed.push(command.type);
		},
		options.pendingPrompts !== undefined ? { pendingPrompts: options.pendingPrompts } : {},
	);
	const sessionPath = join(dir, "s.jsonl");
	const sessionId = opened(
		await rig.open("a", {
			cwd: dir,
			sessionPath,
			...(options.retain === true ? { retain_on_disconnect: true } : {}),
		}),
		0,
	).sessionId;
	const closes = () =>
		rig.recordsFor("a").filter((record) => record.type === "session_closed" && record.sessionId === sessionId);
	return { rig, sessionId, sessionPath, closes, routed, exited: exited.promise };
}

async function parkRecords(daemonDir: string): Promise<Record<string, unknown>[]> {
	const dir = join(daemonDir, "handover-parked");
	const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith(".json"));
	return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(dir, name), "utf8"))));
}

describe("a handoff drain parks only a session proven quiet", () => {
	it("keeps a session whose prompt is still in preflight until that prompt settles", async () => {
		let preflight: readonly Promise<unknown>[] = [new Promise(() => {})];
		const { rig, sessionId, closes, exited } = await drainRig({ pendingPrompts: () => preflight });
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		rig.router.beginDrain();
		await rig.settle();
		expect(closes()).toEqual([]);
		expect(rig.registry.peek(sessionId)?.state).toBe("open");

		preflight = [];
		rig.router.beginDrain();
		await exited;
		await rig.settle();
		expect(closes()).toEqual([expect.objectContaining({ reason: "handoff_parked" })]);
	}, 10_000);

	it.each(["queued", "delivery"] as const)(
		"keeps a session with %s input still owed a turn",
		async (kind) => {
			const { rig, sessionId, closes, exited } = await drainRig();
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const session = rig.registry.peek(sessionId)?.runtime?.session;
			const [turn] = [...rig.turns.values()];
			if (session === undefined || turn === undefined) throw new Error("the session did not open");
			if (kind === "queued") Object.defineProperty(session, "pendingMessageCount", { value: 1, configurable: true });
			else turn.pendingDeliveries.push("delivery-1");

			rig.router.beginDrain();
			await rig.settle();
			expect(closes()).toEqual([]);

			if (kind === "queued") Object.defineProperty(session, "pendingMessageCount", { value: 0, configurable: true });
			else turn.pendingDeliveries.splice(0);
			rig.router.beginDrain();
			await exited;
			await rig.settle();
			expect(closes()).toEqual([expect.objectContaining({ reason: "handoff_parked" })]);
		},
		10_000,
	);
});

describe("a retained session's transfer", () => {
	it("keeps the session open while its park record cannot be written, and parks it once it can", async () => {
		let now = 1_000;
		const daemonDir = join(await scratch(), "daemon");
		await mkdir(daemonDir, { recursive: true });
		// A file where the record directory belongs: every record write fails until it is removed.
		await writeFile(join(daemonDir, "handover-parked"), "not a directory\n");
		const { rig, sessionId, sessionPath, closes, exited } = await drainRig({
			parkedDir: daemonDir,
			now: () => now,
			retain: true,
		});
		const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		rig.router.beginDrain();
		await rig.settle();
		expect(closes()).toEqual([]);
		expect(rig.registry.peek(sessionId)?.state).toBe("open");
		expect(log).toHaveBeenCalledWith(expect.stringContaining("could not be written; the session stays here"));

		await rm(join(daemonDir, "handover-parked"));
		now += 60_000;
		rig.router.beginDrain();
		await exited;
		await rig.settle();
		expect(closes()).toEqual([expect.objectContaining({ reason: "handoff_parked" })]);
		expect(await parkRecords(daemonDir)).toEqual([
			expect.objectContaining({
				sessionPath: join(realpathSync(dirname(sessionPath)), basename(sessionPath)),
				transferId: expect.any(String),
			}),
		]);
	}, 10_000);

	it("answers new work with session_closing and its transfer while it is sealed, and lets reads through", async () => {
		const daemonDir = join(await scratch(), "daemon");
		const { rig, sessionId, routed, exited } = await drainRig({ parkedDir: daemonDir, retain: true });

		// The drain seals the session in the step that judged it quiet; its record write is still in flight.
		rig.router.beginDrain();
		const refused = rig.send("a", { type: "prompt", id: "late-prompt", sessionId, message: "late work" });
		const read = rig.send("a", { type: "get_state", id: "late-read", sessionId });
		const [answer] = await Promise.all([refused, read]);
		await exited;
		await rig.settle();

		expect(answer).toMatchObject({
			success: false,
			error: "session_closing",
			errorData: { reason: "handoff_transfer", transfer_id: expect.any(String) },
		});
		expect(routed).toEqual(["get_state"]);
		const [record] = await parkRecords(daemonDir);
		expect(record?.transferId).toBe((answer?.errorData as { transfer_id?: string } | undefined)?.transfer_id);
	}, 10_000);

	it("lets an explicit close that races the transfer win: the session closes and no park record remains", async () => {
		const daemonDir = join(await scratch(), "daemon");
		const { rig, sessionId, closes, exited } = await drainRig({ parkedDir: daemonDir, retain: true });

		rig.router.beginDrain();
		const closed = await rig.close("a", sessionId);
		await exited;
		await rig.settle();

		expect(closed).toMatchObject({ success: true });
		expect(closes()).toEqual([expect.objectContaining({ reason: "client_close" })]);
		expect(await parkRecords(daemonDir)).toEqual([]);
	}, 10_000);
});
