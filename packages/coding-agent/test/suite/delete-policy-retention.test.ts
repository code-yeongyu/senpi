// omo#11072: the trash is bounded (retention, size cap) and every permanent delete leaves an audit row.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	deletePermanently,
	emptyTrash,
	listTrash,
	trashPath,
} from "../../src/core/extensions/builtin/delete-policy/trash.ts";
import {
	auditRows,
	DAY_MS,
	readTree,
	removeTrashSandboxes,
	trashSandbox,
	writeTree,
} from "./delete-policy-fixtures.ts";

afterEach(removeTrashSandboxes);

describe.skipIf(process.platform === "win32")("trash bounds and the audit log", () => {
	it("purges entries past retentionDays on the next trash write and audits each one", async () => {
		const box = await trashSandbox();
		await writeTree(box.work, { "old/a.txt": "aaaa", "new/b.txt": "bb" });
		const old = await trashPath(box.scope(), join(box.work, "old"), "x");

		box.clock.now += 15 * DAY_MS;
		const fresh = await trashPath(box.scope(), join(box.work, "new"), "y");

		await expect(listTrash(box.scope())).resolves.toEqual([fresh]);
		await expect(readdir(join(box.trashDir, "files"))).resolves.toEqual(["new"]);
		await expect(readdir(join(box.trashDir, "info"))).resolves.toEqual(["new.trashinfo"]);
		await expect(auditRows(box.agentDir)).resolves.toEqual([
			{
				ts: new Date(box.clock.now).toISOString(),
				sessionId: "session-test",
				actor: "model",
				path: old.originalPath,
				bytes: old.bytes,
				reason: "retention: older than 14 days",
				trashId: old.id,
			},
		]);
	});

	it("keeps entries inside retention", async () => {
		const box = await trashSandbox();
		await writeTree(box.work, { "a/x": "1", "b/y": "2" });
		const a = await trashPath(box.scope(), join(box.work, "a"), "x");
		box.clock.now += 13 * DAY_MS;
		const b = await trashPath(box.scope(), join(box.work, "b"), "x");

		await expect(listTrash(box.scope())).resolves.toEqual([a, b]);
		await expect(auditRows(box.agentDir)).resolves.toEqual([]);
	});

	it("refuses a write that would pass the size cap and leaves the target in place", async () => {
		const box = await trashSandbox();
		await writeTree(box.work, { "one/f": "x".repeat(3000), "two/f": "y".repeat(3000) });
		const one = join(box.work, "one");
		const scope = box.scope({ policy: { maxTrashBytes: 1 } });
		await expect(trashPath(scope, one, "x")).rejects.toMatchObject({ code: "trash_full" });
		await expect(readTree(one)).resolves.toEqual({ f: "x".repeat(3000) });

		const first = await trashPath(box.scope(), one, "x");
		const capShortOfTwo = box.scope({ policy: { maxTrashBytes: 2 * first.bytes - 1 } });
		await expect(trashPath(capShortOfTwo, join(box.work, "two"), "x")).rejects.toMatchObject({
			code: "trash_full",
		});

		await expect(readTree(join(box.work, "two"))).resolves.toEqual({ f: "y".repeat(3000) });
		await expect(listTrash(box.scope())).resolves.toEqual([first]);
	});

	it("empty enforces the cap by deleting the oldest entries first", async () => {
		const box = await trashSandbox();
		await writeTree(box.work, { "a/f": "1".repeat(100), "b/f": "2".repeat(100), "c/f": "3".repeat(100) });
		const entries = [];
		for (const name of ["a", "b", "c"]) {
			entries.push(await trashPath(box.scope(), join(box.work, name), "x"));
			box.clock.now += 1000;
		}
		const [a, b, c] = entries;
		const capForOne = Math.max(...entries.map((entry) => entry.bytes));

		const rows = await emptyTrash(box.scope({ actor: "user", policy: { maxTrashBytes: capForOne } }), {
			kind: "policy",
		});

		expect(rows.map((row) => [row.trashId, row.reason])).toEqual([
			[a?.id, `size-cap: trash over ${capForOne} bytes`],
			[b?.id, `size-cap: trash over ${capForOne} bytes`],
		]);
		await expect(listTrash(box.scope())).resolves.toEqual([c]);
		await expect(auditRows(box.agentDir)).resolves.toEqual(rows);
	});

	it("empty --older-than and --all delete only what they select, one audit row per entry", async () => {
		const box = await trashSandbox();
		await writeTree(box.work, { "a/f": "1", "b/f": "2" });
		const a = await trashPath(box.scope(), join(box.work, "a"), "x");
		box.clock.now += 3 * DAY_MS;
		const b = await trashPath(box.scope(), join(box.work, "b"), "x");
		const user = box.scope({ actor: "user", sessionId: null });

		const older = await emptyTrash(user, { kind: "older-than", ms: 2 * DAY_MS });
		expect(older.map((row) => row.trashId)).toEqual([a.id]);
		await expect(listTrash(user)).resolves.toEqual([b]);

		const all = await emptyTrash(user, { kind: "all" });
		expect(all).toEqual([
			{
				ts: new Date(box.clock.now).toISOString(),
				sessionId: null,
				actor: "user",
				path: b.originalPath,
				bytes: b.bytes,
				reason: "empty: all",
				trashId: b.id,
			},
		]);
		await expect(readdir(join(box.trashDir, "files"))).resolves.toEqual([]);
		await expect(auditRows(box.agentDir)).resolves.toEqual([...older, ...all]);
	});

	it("an explicit permanent delete is audited, needs a reason, and is refused to the model under trash-only", async () => {
		const box = await trashSandbox();
		const target = join(box.work, "scratch");
		await writeTree(target, { f: "12345" });

		await expect(deletePermanently(box.scope(), target, "  ")).rejects.toMatchObject({ code: "refused" });
		await expect(
			deletePermanently(box.scope({ policy: { mode: "trash-only" } }), target, "secret material"),
		).rejects.toMatchObject({ code: "refused" });
		await expect(readTree(target)).resolves.toEqual({ f: "12345" });
		await expect(auditRows(box.agentDir)).resolves.toEqual([]);

		const row = await deletePermanently(box.scope(), target, "secret material");

		await expect(readdir(box.work)).resolves.toEqual([]);
		expect(row).toMatchObject({ actor: "model", path: target, reason: "permanent: secret material", trashId: null });
		expect(row.bytes).toBeGreaterThanOrEqual(5);
		await expect(auditRows(box.agentDir)).resolves.toEqual([row]);
	});
});
