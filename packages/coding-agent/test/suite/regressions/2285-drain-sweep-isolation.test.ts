import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { opened } from "../rpc-inprocess-host-metrics.ts";
import { createInProcessRig } from "../rpc-inprocess-host-support.ts";

// senpi #2285. A handoff drain parks every settled session, then exits the superseded generation.
// One session that throws while it is listed or judged used to abort the whole pass before the
// drain timer was armed, so the rest never parked and the generation never exited.

const scratchDirs: string[] = [];
afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const dir of scratchDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function drainRig() {
	const dir = await mkdtemp(join(tmpdir(), "senpi-2285-"));
	scratchDirs.push(dir);
	const exited = Promise.withResolvers<void>();
	const rig = createInProcessRig(dir, { onEmptyExit: () => exited.resolve() });
	const childDir = join(dir, "children", "st_gone", "sessions");
	await mkdir(childDir, { recursive: true });
	const s1 = opened(await rig.open("a", { cwd: dir, sessionPath: join(childDir, "s1.jsonl") }), 0).sessionId;
	const s2 = opened(await rig.open("b", { cwd: dir, sessionPath: join(dir, "s2.jsonl") }), 1).sessionId;
	const closes = (connection: string, sessionId: string) =>
		rig.recordsFor(connection).filter((record) => record.type === "session_closed" && record.sessionId === sessionId);
	const reasons = () => [...closes("a", s1), ...closes("b", s2)].map((record) => record.reason);
	return { dir, rig, s1, s2, closes, reasons, exited: exited.promise };
}

it("ends a session whose directory was deleted as session_dir_removed and still parks the rest", async () => {
	const { dir, rig, s1, s2, closes, exited } = await drainRig();
	await rm(join(dir, "children"), { recursive: true, force: true });

	rig.router.beginDrain();
	await exited;
	await rig.settle();

	expect(closes("a", s1)).toEqual([expect.objectContaining({ reason: "session_dir_removed" })]);
	expect(closes("a", s1)[0]).not.toHaveProperty("sessionPath");
	expect(closes("b", s2)).toEqual([
		expect.objectContaining({ reason: "handoff_parked", sessionPath: expect.stringMatching(/s2\.jsonl$/) }),
	]);
	expect(rig.registry.size).toBe(0);
}, 10_000);

it("parks a session whose activity cannot be read instead of stranding every other session", async () => {
	const { rig, s1, reasons, exited } = await drainRig();
	const session = rig.registry.peek(s1)?.runtime?.session;
	expect(session).toBeDefined();
	Object.defineProperty(session, "activitySnapshot", {
		get() {
			throw new Error("activity unreadable");
		},
	});
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);

	expect(() => rig.router.beginDrain()).not.toThrow();
	await exited;
	await rig.settle();

	expect(reasons()).toEqual(["handoff_parked", "handoff_parked"]);
}, 10_000);

it("retries a drain pass that failed as a whole on the armed drain timer", async () => {
	const { rig, reasons, exited } = await drainRig();
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	const list = vi.spyOn(rig.registry, "list").mockImplementationOnce(() => {
		throw Object.assign(new Error("ENOENT: no such file or directory, lstat '/gone'"), { code: "ENOENT" });
	});

	expect(() => rig.router.beginDrain()).not.toThrow();
	expect(list).toHaveBeenCalledTimes(1);
	expect(rig.records().some((record) => record.type === "session_closed")).toBe(false);

	vi.advanceTimersToNextTimer();
	await exited;
	await rig.settle();
	expect(reasons()).toEqual(["handoff_parked", "handoff_parked"]);
}, 10_000);

it("completes when the drain is requested again after a failed pass", async () => {
	const { rig, reasons, exited } = await drainRig();
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	vi.spyOn(rig.registry, "list").mockImplementationOnce(() => {
		throw new Error("listing failed");
	});

	expect(() => rig.router.beginDrain()).not.toThrow();
	// Grace expiry or a second SIGUSR1 re-enters the drain on the same router.
	expect(() => rig.router.beginDrain()).not.toThrow();
	await exited;
	await rig.settle();
	expect(reasons()).toEqual(["handoff_parked", "handoff_parked"]);
}, 10_000);
