import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { availability, session, textOf } from "./load-cell-session.ts";

const pythonReady = availability.py.detected.ok;

type ListedCells = Awaited<ReturnType<Awaited<ReturnType<typeof session>>["list"]>>;

/** Waits until `cellId` is waiting in the kernel queue behind `aheadId`, or has already settled. */
async function queuedBehindOrSettled(
	list: () => Promise<ListedCells>,
	cellId: string,
	aheadId: string,
	settled: () => boolean,
): Promise<void> {
	await vi.waitFor(
		async () => {
			if (settled()) return;
			const cell = (await list()).find((listed) => listed.cellId === cellId);
			if (!cell?.queuedBehind?.includes(aheadId)) throw new Error(`${cellId} is not queued behind ${aheadId} yet`);
		},
		{ timeout: 30_000, interval: 20 },
	);
}
const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("Given a %load cell queued behind the cell that writes its file", () => {
	it.skipIf(!pythonReady)(
		"When the Python cell ahead writes the file, then the %load runs what it wrote",
		async () => {
			const { run, list, gateReached, openGate } = await session({});
			const writer = run("py", "tool.gate({})\nopen('late.py', 'w').write('LATE = 7\\n')", "writer-py");
			await gateReached;

			let settled = false;
			const loading = run("py", "%load ./late.py", "loader-py").finally(() => {
				settled = true;
			});
			await queuedBehindOrSettled(list, "loader-py", "writer-py", () => settled);
			openGate();
			await writer;
			const loaded = await loading;
			const value = await run("py", "LATE");

			expect(loaded.details).not.toHaveProperty("isError", true);
			expect(textOf(value).trim()).toBe("7");
		},
		120_000,
	);

	it("When the JavaScript cell ahead writes the file, then the %load runs what it wrote", async () => {
		const { run, list, gateReached, openGate } = await session({});
		const writer = run(
			"js",
			'import { writeFileSync } from "node:fs";\nawait tool.gate({});\nwriteFileSync("late.js", "globalThis.LATE = 9;\\n");',
			"writer-js",
		);
		await gateReached;

		let settled = false;
		const loading = run("js", "%load ./late.js", "loader-js").finally(() => {
			settled = true;
		});
		await queuedBehindOrSettled(list, "loader-js", "writer-js", () => settled);
		openGate();
		await writer;
		const loaded = await loading;
		const value = await run("js", "globalThis.LATE");

		expect(loaded.details).not.toHaveProperty("isError", true);
		expect(textOf(value).trim()).toBe("9");
	}, 120_000);
});

describe.skipIf(!pythonReady)("Given a Python file loaded with %load from a sub-directory", () => {
	it("When a later cell runs, then that directory is off the import path and __file__ is gone", async () => {
		const { root, run } = await session({});
		await mkdir(join(root, "lib"));
		await writeFile(join(root, "lib", "helpers.py"), "def f(x):\n    return x\n");

		await run("py", "%load ./lib/helpers.py");
		const after = await run(
			"py",
			`import sys\n(${JSON.stringify(join(root, "lib"))} in sys.path, '__file__' in globals(), f(5))`,
		);

		expect(textOf(after)).toContain("(False, False, 5)");
	}, 120_000);

	it("When the loaded file shadows a standard-library module name, then a later cell still imports the standard library", async () => {
		const { root, run } = await session({});
		await mkdir(join(root, "lib"));
		await writeFile(join(root, "lib", "json.py"), "SHADOW = True\n");
		await writeFile(join(root, "lib", "loader.py"), "LOADED = True\n");

		await run("py", "%load ./lib/loader.py");
		const later = await run(
			"py",
			"import importlib, json\nimportlib.reload(json)\n(hasattr(json, 'SHADOW'), hasattr(json, 'dumps'))",
		);

		expect(textOf(later)).toContain("(False, True)");
	}, 120_000);
});

describe.skipIf(!pythonReady)("Given a %load path that cannot be read", () => {
	const cases = [
		["a file:// URL naming a host", "file://real.py"],
		["a file:// URL with an encoded slash", "file:///tmp/a%2Fb.py"],
		["a malformed local:// escape", "local://%zz"],
		["a path through a file", "./real.py/inner.py"],
	] as const;

	for (const [label, target] of cases) {
		it(`When it is ${label}, then the cell fails with a message naming the target and no absolute path`, async () => {
			const { root, run } = await session({ "real.py": "X = 1\n" });

			const failed = await run("py", `%load ${target}`);

			expect(failed.details).toMatchObject({ isError: true });
			expect(textOf(failed)).toContain(target);
			expect(textOf(failed)).not.toContain(root);
		}, 120_000);
	}

	it("When the file is larger than 8 MiB, then the cell is refused before anything is read", async () => {
		const { run, root } = await session({});
		await writeFile(join(root, "huge.py"), "#".repeat(8 * 1024 * 1024 + 1));

		const refused = await run("py", "%load ./huge.py");

		expect(textOf(refused)).toContain("%load reads files up to 8 MiB: ./huge.py");
	}, 120_000);

	it.skipIf(runningAsRoot)(
		"When the file is unreadable, then the cell fails with permission denied and no absolute path",
		async () => {
			const { root, run } = await session({ "secret.py": "X = 1\n" });
			await chmod(join(root, "secret.py"), 0o000);

			const failed = await run("py", "%load ./secret.py");

			expect(textOf(failed)).toContain("permission denied: ./secret.py");
			expect(textOf(failed)).not.toContain(root);
		},
		120_000,
	);
});

describe.skipIf(!pythonReady)("Given a %load target written as a URL", () => {
	it("When it is a file:// URL of a real file, then the file runs as the cell", async () => {
		const { root, run } = await session({ "h.py": "VIA_FILE_URL = 3\n" });

		await run("py", `%load ${pathToFileURL(join(root, "h.py")).href}`);
		const value = await run("py", "VIA_FILE_URL");

		expect(textOf(value)).toContain("3");
	}, 120_000);

	it("When it is local:// under the session artifacts, then the file runs as the cell", async () => {
		const { run, artifactsDir } = await session({});
		await mkdir(join(artifactsDir, "local"), { recursive: true });
		await writeFile(join(artifactsDir, "local", "art.py"), "VIA_LOCAL = 4\n");

		await run("py", "%load local://art.py");
		const value = await run("py", "VIA_LOCAL");

		expect(textOf(value)).toContain("4");
	}, 120_000);

	it("When local:// climbs out of the artifacts root, then the cell is refused", async () => {
		const { run } = await session({});

		const refused = await run("py", "%load local://../escape.py");

		expect(textOf(refused)).toContain("%load path escapes local://: local://../escape.py");
	}, 120_000);
});
