import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { runProcess } from "../../scripts/gate-process.ts";

it.each([
	["gate", "../../scripts/gate-import-observer.ts"],
	["inventory", "../../../coding-agent/test/runtime-snapshot/inventory-preload.mjs"],
])("keeps %s observer writes outside cell interposition", async (kind, relative) => {
	const root = await mkdtemp(join(tmpdir(), "observer-interposition-"));
	const observer = fileURLToPath(new URL(relative, import.meta.url));
	const trace = join(root, "trace.jsonl");
	const target = join(root, "node_modules", "fixture.mjs");
	try {
		await mkdir(join(root, "node_modules"));
		await writeFile(target, "export const value = 42;");
		const result = await runProcess(
			[
				"node",
				"--import",
				"tsx",
				"--input-type=module",
				"--eval",
				`
			process.env.SENPI_GATE_IMPORT_FILE=${JSON.stringify(trace)};
			process.env.SENPI_GATE_IMPORT_PHASE="firstKernel";
			process.env.SENPI_INVENTORY_LOG=${JSON.stringify(trace)};
			await import(${JSON.stringify(pathToFileURL(observer).href)});
			const fs=process.getBuiltinModule("node:fs");
			fs.writeFileSync=()=>{throw new Error("cell write refused");};
			await import(${JSON.stringify(pathToFileURL(target).href)});
		`,
			],
			fileURLToPath(new URL("../..", import.meta.url)),
		);
		expect(result.exitCode, result.stderr).toBe(0);
		const records = (await readFile(trace, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const resolved = await realpath(target);
		expect(records).toContainEqual(
			kind === "gate" ? expect.objectContaining({ url: pathToFileURL(resolved).href }) : resolved,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
