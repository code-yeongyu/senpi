import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// code-yeongyu/senpi#2898 fourth review H-fifo: any local user can mkfifo a breadcrumb name in a shared ancestor such
// as /tmp. Opening it must never block: both resolvers answer "not moved" at once. Run in a child with a hard timeout
// so a regression fails this test instead of hanging the worker.

const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const resolveUrl = (name: string) =>
	pathToFileURL(fileURLToPath(new URL(`../../src/core/extensions/builtin/moved-path-guard/${name}`, import.meta.url)))
		.href;

function runChild(script: string, cwd: string) {
	return spawnSync(process.execPath, ["--import", TSX, "--input-type=module", "-e", script], {
		cwd,
		encoding: "utf8",
		timeout: 8000,
		env: { ...process.env, HOME: cwd },
	});
}

describe.runIf(process.platform !== "win32")("moved-path-guard with a FIFO named as a breadcrumb (#2898)", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	function fifoRoot(): string {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "senpi-moved-fifo-")));
		roots.push(root);
		mkdirSync(join(root, "sub"));
		const made = spawnSync("mkfifo", [join(root, "omo-desktop-moved.json")]);
		if (made.status !== 0) throw new Error(`mkfifo failed: ${made.stderr}`);
		return root;
	}

	it("the synchronous resolver returns at once", () => {
		const root = fifoRoot();
		const child = runChild(
			`const { findMovedPath } = await import(${JSON.stringify(resolveUrl("resolve.ts"))});
			const started = Date.now();
			const moved = findMovedPath(${JSON.stringify(join(root, "sub", "x"))});
			console.log(JSON.stringify({ moved: moved ?? null, ms: Date.now() - started }));`,
			root,
		);

		expect(child.error?.message ?? "").not.toContain("ETIMEDOUT");
		expect(JSON.parse(child.stdout.trim())).toMatchObject({ moved: null });
	});

	it("the asynchronous probe returns at once and leaves the threadpool free", () => {
		const root = fifoRoot();
		const child = runChild(
			`const { createMovedPathProbe } = await import(${JSON.stringify(resolveUrl("resolve-async.ts"))});
			const { readFile } = await import("node:fs/promises");
			const started = Date.now();
			const results = [];
			for (let i = 0; i < 6; i++) results.push((await createMovedPathProbe().resolve(${JSON.stringify(join(root, "sub", "x"))})) ?? null);
			const probeMs = Date.now() - started;
			await readFile(${JSON.stringify(import.meta.filename)});
			console.log(JSON.stringify({ results, probeMs, readMs: Date.now() - started - probeMs }));
			process.exit(0);`,
			root,
		);

		expect(child.error?.message ?? "").not.toContain("ETIMEDOUT");
		const out = JSON.parse(child.stdout.trim());
		expect(out.results).toEqual([null, null, null, null, null, null]);
		expect(out.probeMs).toBeLessThan(1000);
		expect(out.readMs).toBeLessThan(1000);
	});
});
