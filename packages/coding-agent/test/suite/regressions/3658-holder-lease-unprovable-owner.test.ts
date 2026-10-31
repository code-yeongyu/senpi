import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { processBootAtMs } from "../../../src/core/extensions/builtin/terminal/process-identity.ts";
import { liveSessionHolders } from "../../../src/core/session-holders.ts";
import { encodedSessionId } from "../../../src/core/session-sidecar-store.ts";

// #3658, third layer: after a tree kill on Windows, the dead host child's session-holder lease stood
// while an unrelated process wore its pid and that process's start time could not be read, so every
// open_session on the replacement host was refused `session_held` (desktop#3157, run 39166325038).
const id = "36580000-0000-4000-8000-000000000003";
const RECORDED_START = 1_700_000_000_000;
let root: string;
let file: string;
let record: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "holder-unprovable-"));
	file = join(root, "session.jsonl");
	await writeFile(file, `${JSON.stringify({ type: "session", version: 3, id, cwd: root })}\n`);
	const dir = join(dirname(file), "session-holders", encodedSessionId(id));
	await mkdir(dir, { recursive: true });
	record = join(dir, "4242.json");
	await writeFile(
		record,
		JSON.stringify({
			pid: 4242,
			bootAtMs: processBootAtMs(),
			processStartedAtMs: RECORDED_START,
			host_instance: "dead-generation",
			host_daemon_dir: join(root, "daemon"),
		}),
	);
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const alive = () => true;
const unreadable = async () => undefined;

it("reclaims a live-pid holder whose identity cannot be proven once its generation ended", async () => {
	const holderEnded = vi.fn(async () => true);
	expect(
		await liveSessionHolders(file, id, { isProcessAlive: alive, readProcessStartMs: unreadable, holderEnded }),
	).toEqual([]);
	expect(holderEnded).toHaveBeenCalledWith(
		expect.objectContaining({ host_instance: "dead-generation", host_daemon_dir: join(root, "daemon") }),
	);
	await expect(readFile(record, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps an unprovable holder when there is no evidence its generation ended (#1609)", async () => {
	expect(
		await liveSessionHolders(file, id, {
			isProcessAlive: alive,
			readProcessStartMs: unreadable,
			holderEnded: async () => false,
		}),
	).toEqual([{ pid: 4242, cwd: undefined, host_instance: "dead-generation" }]);
});

it("never asks about the generation of a holder whose start time matches", async () => {
	const holderEnded = vi.fn(async () => true);
	expect(
		await liveSessionHolders(file, id, {
			isProcessAlive: alive,
			readProcessStartMs: async () => RECORDED_START,
			holderEnded,
		}),
	).toHaveLength(1);
	expect(holderEnded).not.toHaveBeenCalled();
});
