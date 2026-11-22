import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

// The package's default Vitest host is Node until S21b; exercise the native backend in a Bun child on both hosts.
it("reopens imported tails and a hatch fork from a real Bun SQLite store", async () => {
	const result = await promisify(execFile)(
		"bun",
		[fileURLToPath(new URL("./fixtures/sqlite-reopen.ts", import.meta.url))],
		{ cwd: fileURLToPath(new URL("../../../../", import.meta.url)), timeout: 20_000 },
	);
	expect(result.stderr).toBe("");
}, 30_000);

// #5955 review: an entry a co-bound process appended must survive the file's later ordinary appends, not only the import
// that met it. Two processes on one store file: an importer process and a peer appender process.
it("keeps a co-bound peer's entry across the file's later appends (two processes, one sqlite store)", async () => {
	const root = await mkdtemp(join(tmpdir(), "s21ba-import-"));
	const database = join(root, "store.sqlite");
	const path = join(root, "source.jsonl");
	const header = { type: "session", version: 3, id: "s", cwd: "/fixture", timestamp: "2026-01-01" };
	const entry = (id: string, parentId: string | null) => ({
		type: "custom",
		id,
		parentId,
		timestamp: "2026-01-01",
		customType: "fixture",
		data: id,
	});
	const file = (ids: string[]) =>
		[header, ...ids.map((id, index) => entry(id, index === 0 ? null : (ids[index - 1] ?? null)))]
			.map((value) => JSON.stringify(value))
			.join("\n") + "\n";
	const step = async (args: object) => {
		const { stdout } = await promisify(execFile)(
			"bun",
			[
				fileURLToPath(new URL("./fixtures/co-bound-import-step.ts", import.meta.url)),
				JSON.stringify({ database, ...args }),
			],
			{ cwd: fileURLToPath(new URL("../../../../", import.meta.url)), timeout: 20_000 },
		);
		return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
	};
	try {
		await writeFile(path, file(["a"]));
		expect(await step({ action: "import", path })).toMatchObject({ outcome: "imported" });
		expect(await step({ action: "append", key: "x" })).toEqual({ appended: "x" });
		await writeFile(path, file(["a", "b"]));
		expect(await step({ action: "import", path })).toMatchObject({ outcome: "extended" });
		expect(await step({ action: "read" })).toEqual({ keys: ["a", "x", "b"] });

		await writeFile(path, file(["a", "b", "c"]));
		expect(await step({ action: "import", path })).toMatchObject({ outcome: "extended", imported: 1 });
		expect(await step({ action: "read" })).toEqual({ keys: ["a", "x", "b", "c"] });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 120_000);
