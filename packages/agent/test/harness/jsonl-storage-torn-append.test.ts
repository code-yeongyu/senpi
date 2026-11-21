import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT, type Context } from "../../src/harness/context.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import * as sessionWrites from "../../src/harness/session/commit.ts";
import {
	JSONL_FORMAT_VERSION,
	JsonlStorage,
	type JsonlStorageHeader,
	type JsonlStorageRecovery,
} from "../../src/harness/session/jsonl/index.ts";
import { err, FileError, type Result } from "../../src/harness/types.ts";
import { createTempDir } from "./session-test-utils.ts";

const NOW = 1_700_000_000_000;
const PATH = "s.jsonl";

const header: JsonlStorageHeader = {
	v: JSONL_FORMAT_VERSION,
	kind: "header",
	id: "torn-append",
	storageVersion: 1,
	createdAt: NOW,
	cwd: "/workspace",
};

const entry = (id: string, parentId: string | null) =>
	sessionWrites.insertEntry({
		id,
		parentId,
		type: "message",
		message: { role: "user", content: `text of ${id}`, timestamp: 1 },
	});

const line = (id: string, parentId: string | null, seq: number) =>
	`${JSON.stringify(sessionWrites.commitWrite(entry(id, parentId), seq, NOW))}\n`;

function noSpace(path: string): FileError {
	const cause = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
	return new FileError("unknown", cause.message, path, cause);
}

/** Lands the first `appendKeeps` characters of the next append, then fails it the way a full volume does. */
class FullDiskEnv extends NodeExecutionEnv {
	appendKeeps: number | undefined;
	failWritesMatching: RegExp | undefined;

	override async appendFile(
		path: string,
		content: string | Uint8Array,
		context: Context,
	): Promise<Result<void, FileError>> {
		const keep = this.appendKeeps;
		if (keep === undefined || typeof content !== "string") return super.appendFile(path, content, context);
		this.appendKeeps = undefined;
		await super.appendFile(path, content.slice(0, keep), context);
		return err(noSpace(path));
	}

	override async writeFile(
		path: string,
		content: string | Uint8Array,
		context: Context,
	): Promise<Result<void, FileError>> {
		if (this.failWritesMatching?.test(path) !== true) return super.writeFile(path, content, context);
		this.failWritesMatching = undefined;
		return err(noSpace(path));
	}
}

function open(fileSystem: NodeExecutionEnv, recoveries: JsonlStorageRecovery[]) {
	return JsonlStorage.open(
		{ fileSystem, path: PATH, now: () => NOW, onRecovery: (recovery) => recoveries.push(recovery) },
		BACKGROUND_CONTEXT,
	);
}

async function ids(storage: JsonlStorage): Promise<string[]> {
	const found = await storage.getEntries(["e1", "e2", "e3", "e4", "e5"], BACKGROUND_CONTEXT);
	return [...found.keys()];
}

function backups(cwd: string): string[] {
	return readdirSync(cwd)
		.filter((name) => name.startsWith(`${PATH}.torn-`))
		.map((name) => readFileSync(join(cwd, name), "utf8"));
}

describe("JsonlStorage after an append that failed part-way (ENOSPC)", () => {
	it("never refuses the session at any tear offset, keeps every committed record and never reuses a sequence", async () => {
		const torn = line("e3", "e2", 3);
		for (let keep = 1; keep <= torn.length; keep++) {
			// Given a session whose third commit ran out of space after `keep` characters
			const cwd = createTempDir();
			const fileSystem = new FullDiskEnv({ cwd });
			const live: JsonlStorageRecovery[] = [];
			const storage = await JsonlStorage.create(
				{ fileSystem, path: PATH, now: () => NOW, onRecovery: (recovery) => live.push(recovery) },
				header,
				[],
				BACKGROUND_CONTEXT,
			);
			await storage.commit([entry("e1", null)], BACKGROUND_CONTEXT);
			await storage.commit([entry("e2", "e1")], BACKGROUND_CONTEXT);
			fileSystem.appendKeeps = keep;
			const refused = await storage.commit([entry("e3", "e2")], BACKGROUND_CONTEXT).then(
				() => undefined,
				(error: unknown) => error,
			);
			// When the disk has room again and the same process commits the next record
			const next = await storage.commit([entry("e4", "e2")], BACKGROUND_CONTEXT);
			await storage.close(BACKGROUND_CONTEXT);
			const reopenedRecoveries: JsonlStorageRecovery[] = [];
			const reopened = await open(new NodeExecutionEnv({ cwd }), reopenedRecoveries);

			// Then the failed commit was reported, its sequence was not reused, and the session reopens whole
			expect(refused, `keep=${keep}`).toBeInstanceOf(Error);
			expect(next.firstSeq, `keep=${keep}`).toBe(4);
			expect(await ids(reopened), `keep=${keep}`).toEqual(["e1", "e2", "e4"]);
			// And the torn bytes were set aside once, with the disk-full cause, before the next append
			expect(backups(cwd), `keep=${keep}`).toEqual([torn.slice(0, keep)]);
			expect(
				live.map((recovery) => recovery.cause),
				`keep=${keep}`,
			).toEqual(["disk_full"]);
			expect(reopenedRecoveries, `keep=${keep}`).toEqual([]);
			await reopened.close(BACKGROUND_CONTEXT);
		}
	});

	it("reopens a file whose torn record was glued to the next one and keeps the records on both sides", async () => {
		// Given a file written before this fix: a torn e3 with the next commit glued onto it
		const cwd = createTempDir();
		const fragment = line("e3", "e2", 3).slice(0, 17);
		const head = `${JSON.stringify(header)}\n${line("e1", null, 1)}${line("e2", "e1", 2)}`;
		const tail = `${line("e4", "e2", 4)}${line("e5", "e4", 5)}`;
		writeFileSync(join(cwd, PATH), `${head}${fragment}${tail}`);

		// When it is opened twice
		const recoveries: JsonlStorageRecovery[] = [];
		const reopened = await open(new NodeExecutionEnv({ cwd }), recoveries);
		const entries = await ids(reopened);
		await reopened.close(BACKGROUND_CONTEXT);
		const again: JsonlStorageRecovery[] = [];
		await (await open(new NodeExecutionEnv({ cwd }), again)).close(BACKGROUND_CONTEXT);

		// Then every whole record is kept, the fragment is set aside, and the file is repaired once
		expect(entries).toEqual(["e1", "e2", "e4", "e5"]);
		expect(backups(cwd)).toEqual([fragment]);
		expect(readFileSync(join(cwd, PATH), "utf8")).toBe(`${head}${tail}`);
		expect(recoveries.map(({ cause, droppedRecords }) => ({ cause, droppedRecords }))).toEqual([
			{ cause: "unknown", droppedRecords: 1 },
		]);
		expect(again).toEqual([]);
	});

	it("sets aside a line that is not JSON or reuses an earlier sequence, and keeps the records after it", async () => {
		// Given an interior line that is not JSON and a later line that repeats sequence 3
		const cwd = createTempDir();
		const reused = line("e9", "e2", 3);
		const content = `${JSON.stringify(header)}\n${line("e1", null, 1)}${line("e2", "e1", 2)}not-json\n${line("e3", "e2", 3)}${reused}${line("e4", "e3", 4)}`;
		writeFileSync(join(cwd, PATH), content);

		// When it is opened
		const recoveries: JsonlStorageRecovery[] = [];
		const reopened = await open(new NodeExecutionEnv({ cwd }), recoveries);

		// Then the session opens with every valid record and both bad lines are kept aside
		expect(await ids(reopened)).toEqual(["e1", "e2", "e3", "e4"]);
		expect(backups(cwd)).toEqual([`not-json\n${reused}`]);
		expect(recoveries.map((recovery) => recovery.droppedRecords)).toEqual([2]);
		await reopened.close(BACKGROUND_CONTEXT);
	});

	it("opens while the set-aside copy cannot be written, and repairs the file before the next append", async () => {
		// Given a torn final line and a volume that is still full when the session opens
		const cwd = createTempDir();
		const head = `${JSON.stringify(header)}\n${line("e1", null, 1)}`;
		const fragment = line("e2", "e1", 2).slice(0, 30);
		writeFileSync(join(cwd, PATH), `${head}${fragment}`);
		const fileSystem = new FullDiskEnv({ cwd });
		fileSystem.failWritesMatching = /\.torn-/;

		// When the session opens and then commits once there is room
		const recoveries: JsonlStorageRecovery[] = [];
		const reopened = await open(fileSystem, recoveries);
		const beforeCommit = readFileSync(join(cwd, PATH), "utf8");
		await reopened.commit([entry("e3", "e1")], BACKGROUND_CONTEXT);
		await reopened.close(BACKGROUND_CONTEXT);

		// Then nothing was lost while the disk was full, and the fragment was set aside before the append
		expect(beforeCommit).toBe(`${head}${fragment}`);
		expect(backups(cwd)).toEqual([fragment]);
		expect(readFileSync(join(cwd, PATH), "utf8")).toBe(`${head}${line("e3", "e1", 2)}`);
		expect(recoveries.map((recovery) => recovery.cause)).toEqual(["unknown"]);
	});
});
