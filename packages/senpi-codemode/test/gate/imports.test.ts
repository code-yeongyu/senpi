import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { moduleKey, scopeImports } from "../../scripts/gate-import-scope.ts";
import { runProcess } from "../../scripts/gate-process.ts";
import { createTarget } from "./import-target-fixture.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scripts = join(packageRoot, "scripts");
const reportSchema = Type.Object({
	extension: Type.Array(Type.String()),
	firstKernel: Type.Array(Type.String()),
	sizes: Type.Record(Type.String(), Type.Number()),
});

async function census(target: string) {
	const result = await runProcess(
		[
			"node",
			"--import",
			"tsx",
			"--import",
			join(scripts, "gate-import-observer.ts"),
			join(scripts, "gate-imports.ts"),
			target,
		],
		packageRoot,
	);
	expect(result.exitCode, result.stderr).toBe(0);
	const line = result.stdout.split("\n").find((entry) => entry.startsWith("GATE_IMPORTS:"));
	if (line === undefined) throw new TypeError("Import census produced no report");
	const report: unknown = JSON.parse(line.slice("GATE_IMPORTS:".length));
	if (!Check(reportSchema, report)) throw new TypeError("Import census produced an invalid report");
	return report;
}

describe("cold eager import census", () => {
	it("removes its trace root and clears observation variables after disposal rejects", async () => {
		// Given: a real worker that retires, followed by a disposal error.
		const root = await mkdtemp(join(tmpdir(), "senpi-census-dispose-"));
		try {
			const target = await createTarget(root);
			await mkdir(join(root, "node_modules"));
			await symlink(
				resolve(packageRoot, "../../node_modules/typebox"),
				join(root, "node_modules/typebox"),
				"junction",
			);
			await writeFile(
				join(target, "src/extension/session-manager.ts"),
				`
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
export async function createCodemodeSessionManager() {
	const traceRoot = dirname(process.env.SENPI_GATE_IMPORT_FILE);
	process.once("exit", () => console.log("GATE_DISPOSE:" + JSON.stringify({
		fileCleared: process.env.SENPI_GATE_IMPORT_FILE === undefined,
		phaseCleared: process.env.SENPI_GATE_IMPORT_PHASE === undefined,
		rootRemoved: !existsSync(traceRoot),
	})));
	let worker;
	return {
		getKernel: async () => ({ run: async () => {
			worker = new Worker(new URL("./worker.ts", import.meta.url));
			await once(worker, "message");
			return { ok: true };
		} }),
		dispose: async () => { await worker?.terminate(); throw new Error("fixture disposal failure"); },
	};
}`,
			);
			// When: the real census encounters that failed retirement.
			const result = await runProcess(
				[
					"node",
					"--import",
					"tsx",
					"--import",
					join(scripts, "gate-import-observer.ts"),
					join(scripts, "gate-imports.ts"),
					target,
				],
				packageRoot,
			);
			// Then: it still cleans ownership state and returns the failed process status.
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("fixture disposal failure");
			const line = result.stdout.split("\n").find((entry) => entry.startsWith("GATE_DISPOSE:"));
			if (!line) throw new TypeError("Missing disposal witness");
			const witness: unknown = JSON.parse(line.slice("GATE_DISPOSE:".length));
			if (
				!Check(
					Type.Object({
						fileCleared: Type.Boolean(),
						phaseCleared: Type.Boolean(),
						rootRemoved: Type.Boolean(),
					}),
					witness,
				)
			)
				throw new TypeError("Invalid disposal witness");
			expect(witness).toEqual({
				fileCleared: true,
				phaseCleared: true,
				rootRemoved: true,
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 180_000);

	it("counts transitive dependencies equally when the target shares or isolates the harness dependency tree", async () => {
		// Given: identical targets, one sharing the harness dependency cache and one isolated.
		const root = await mkdtemp(join(tmpdir(), "senpi-census-cold-"));
		try {
			const shared = await createTarget(join(root, "shared"));
			const isolated = await createTarget(join(root, "isolated"));
			const dependencies = resolve(packageRoot, "../../node_modules");
			await mkdir(join(root, "shared/node_modules"), { recursive: true });
			await symlink(join(dependencies, "typebox"), join(root, "shared/node_modules/typebox"), "junction");
			await mkdir(join(root, "isolated/node_modules"), { recursive: true });
			await cp(join(dependencies, "typebox"), join(root, "isolated/node_modules/typebox"), { recursive: true });
			for (const directory of ["shared", "isolated"]) {
				for (const name of ["fixture-parent", "fixture-peer", "fixture-parent/node_modules/fixture-peer"]) {
					const dependency = join(root, directory, "node_modules", name);
					await mkdir(dependency, { recursive: true });
					await writeFile(join(dependency, "package.json"), '{"type":"module","main":"index.js"}');
					await writeFile(
						join(dependency, "index.js"),
						name === "fixture-parent"
							? 'import { value } from "fixture-peer"; export const dependency = value;'
							: "export const value = 1;",
					);
				}
				await writeFile(
					join(root, directory, "packages/senpi-codemode/src/index.ts"),
					'import { Type } from "typebox"; import { dependency } from "fixture-parent"; import { value } from "fixture-peer"; export const schema = Type.String(); export const observed = dependency + value;',
				);
			}
			// When: the real probe measures both targets in fresh processes.
			const sharedReport = await census(shared);
			const isolatedReport = await census(isolated);
			// Then: checkout ownership cannot hide the actual transitive module graph.
			const virtualRoot = `${moduleKey(pathToFileURL(await realpath(join(dependencies, "typebox"))).href)}/`;
			expect(sharedReport.extension.some((entry) => entry.startsWith(virtualRoot))).toBe(false);
			expect(sharedReport.extension).toEqual(isolatedReport.extension);
			expect(sharedReport.firstKernel).toEqual(isolatedReport.firstKernel);
			expect(sharedReport.extension).toEqual(
				expect.arrayContaining([
					"node_modules/fixture-parent/index.js",
					"node_modules/fixture-peer/index.js",
					"node_modules/fixture-parent/node_modules/fixture-peer/index.js",
				]),
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 180_000);

	it("scopes a builtin only through the owned parent edges present in each phase", async () => {
		// Given: a host-only builtin in extension, later also used by our first kernel.
		const root = await mkdtemp(join(tmpdir(), "senpi-census-builtin-"));
		try {
			const target = await createTarget(root);
			await mkdir(join(root, "node_modules"));
			await symlink(
				resolve(packageRoot, "../../node_modules/typebox"),
				join(root, "node_modules/typebox"),
				"junction",
			);
			const entry = pathToFileURL(join(target, "src/index.ts")).href;
			const worker = pathToFileURL(join(target, "src/extension/worker.ts")).href;
			const host = pathToFileURL(join(root, "node_modules/fixture-host/index.js")).href;
			await mkdir(join(root, "node_modules/fixture-host"));
			await writeFile(join(root, "node_modules/fixture-host/package.json"), '{"type":"module","main":"index.js"}');
			await writeFile(join(root, "node_modules/fixture-host/index.js"), "export const fixture = true;");
			await writeFile(
				join(root, "packages/coding-agent/src/core/extensions/virtual-modules.ts"),
				'import * as box from "typebox"; import * as host from "fixture-host"; export const VIRTUAL_MODULES = { typebox: box, "fixture-host": host };',
			);
			const frames = [
				{ phase: "extension", url: entry, thread: 0, specifier: entry },
				{ phase: "extension", url: host, thread: 0, parent: entry, specifier: "fixture-host" },
				{ phase: "extension", url: "node:crypto", thread: 0, parent: host, specifier: "node:crypto" },
				{ phase: "firstKernel", url: worker, thread: 1, parent: entry, specifier: worker },
				{ phase: "firstKernel", url: "node:crypto", thread: 1, parent: worker, specifier: "node:crypto" },
			];
			// When: each measured phase walks its own complete parent graph.
			const report = await scopeImports(target, frames);
			// Then: the host's earlier builtin cannot inflate our extension census.
			expect(report.extension).not.toContain("node:crypto");
			expect(report.firstKernel).toContain("node:crypto");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("ignores a new host-only dependency but names a new codemode eager import", async () => {
		// Given: an extension importing a real virtual root whose external closure is host-owned.
		const root = await mkdtemp(join(tmpdir(), "senpi-census-scope-"));
		try {
			const target = await createTarget(root);
			await mkdir(join(root, "node_modules"));
			await symlink(
				resolve(packageRoot, "../../node_modules/typebox"),
				join(root, "node_modules/typebox"),
				"junction",
			);
			await mkdir(join(root, "node_modules/fixture-host"));
			await writeFile(
				join(root, "node_modules/fixture-host/package.json"),
				'{"type":"module","exports":{"import":"./index.js"}}',
			);
			await writeFile(join(root, "node_modules/fixture-host/index.js"), "export const value = 1;");
			for (const file of ["loader.ts", "virtual-modules.ts"]) {
				await writeFile(
					join(root, "packages/coding-agent/src/core/extensions", file),
					'import * as box from "typebox"; import * as host from "fixture-host"; export const VIRTUAL_MODULES = { typebox: box, "fixture-host": host };',
				);
			}
			await writeFile(
				join(target, "src/index.ts"),
				'import { value } from "fixture-host"; export const schema = value;',
			);
			const initial = await census(target);
			await mkdir(join(root, "node_modules/fixture-host-dependency"));
			await writeFile(
				join(root, "node_modules/fixture-host-dependency/package.json"),
				'{"type":"module","main":"index.js"}',
			);
			await writeFile(join(root, "node_modules/fixture-host-dependency/index.js"), "export const dependency = 2;");
			await writeFile(
				join(root, "node_modules/fixture-host/index.js"),
				'import { dependency } from "fixture-host-dependency"; export const value = dependency;',
			);
			const unrelated = await census(target);
			expect(unrelated.extension).toEqual(initial.extension);
			expect(unrelated.firstKernel).toEqual(initial.firstKernel);
			await writeFile(join(target, "src/zz-gate-probe.ts"), "export const probe = 1;");
			await writeFile(
				join(target, "src/index.ts"),
				'import { value } from "fixture-host"; import "./zz-gate-probe.ts"; export const schema = value;',
			);
			// When: the cold probe observes a new eager module owned by codemode.
			const changed = await census(target);
			// Then: the exact scoped set exposes the added file.
			expect(changed.extension.filter((entry) => !initial.extension.includes(entry))).toEqual([
				"packages/senpi-codemode/src/zz-gate-probe.ts",
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 180_000);
});
