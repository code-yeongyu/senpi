import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { createLocalFileOps } from "../src/files/local-files.ts";

// The walking backend (used when fd is not on PATH) is where an empty glob pattern matched nothing; fd matched all.
const savedPath = process.env.PATH;
const dirs: string[] = [];
afterEach(async () => {
	process.env.PATH = savedPath;
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("a rooted glob pattern ending in a separator, on the walking backend", () => {
	it("lists that directory exactly as '*' does, absolute or through '..'", async () => {
		const base = await mkdtemp(join(tmpdir(), "glob-trailing-"));
		dirs.push(base);
		const root = join(base, "root");
		await mkdir(join(root, "dir"), { recursive: true });
		await writeFile(join(root, "dir", "a.ts"), "a");
		await writeFile(join(root, "dir", "b.ts"), "b");
		process.env.PATH = await mkdtemp(join(tmpdir(), "glob-no-fd-path-"));
		dirs.push(process.env.PATH);
		const files = createLocalFileOps({});
		const ctx = () =>
			({
				scope: { id: "s", root },
				principal: { kind: "local-session", id: "p" },
				signal: new AbortController().signal,
				limits: {
					readMaxBytes: 1 << 20,
					execStdoutMaxBytes: 0,
					execStderrMaxBytes: 0,
					execTimeoutDefaultMs: 60_000,
				},
				policy: {},
			}) as never;
		const paths = async (req: { pattern: string; cwd?: string }) =>
			(await files.glob(req as never, ctx())).entries.map((entry) => entry.path).sort();
		const star = await paths({ pattern: "*", cwd: join(root, "dir") });
		assert.deepEqual(star, [join(root, "dir", "a.ts"), join(root, "dir", "b.ts")]);
		assert.deepEqual(await paths({ pattern: `${join(root, "dir")}/` }), star);
		assert.deepEqual(await paths({ pattern: "../dir/", cwd: join(root, "dir") }), star);
	});
});
