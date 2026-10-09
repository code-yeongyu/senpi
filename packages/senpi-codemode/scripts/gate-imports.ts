import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CodemodeSessionManager } from "../src/extension/session-manager.ts";
import { GateInputError } from "./gate-input-error.ts";

const target = process.argv[2];
if (!target) throw new TypeError("Import census requires a target checkout");
const root = await mkdtemp(join(tmpdir(), "senpi-gate-imports-"));
const path = join(root, "imports.jsonl");
const observer = fileURLToPath(new URL("./gate-import-observer.ts", import.meta.url));
const sizes: Record<string, number> = {};
let manager: CodemodeSessionManager | undefined;
try {
	process.env.SENPI_GATE_IMPORT_FILE = path;
	process.env.SENPI_GATE_IMPORT_PHASE = "extension";
	await import(pathToFileURL(observer).href);
	await import(pathToFileURL(`${target}/src/index.ts`).href);
	process.env.SENPI_GATE_IMPORT_PHASE = "firstKernel";
	const { createCodemodeSessionManager }: typeof import("../src/extension/session-manager.ts") = await import(
		pathToFileURL(`${target}/src/extension/session-manager.ts`).href
	);
	const { defaultCodemodeSettings }: typeof import("../src/config/settings.ts") = await import(
		pathToFileURL(`${target}/src/config/settings.ts`).href
	);
	const { createInterpreterDetector, getInterpreterAvailability }: typeof import("../src/interpreters/detect.ts") = await import(
		pathToFileURL(`${target}/src/interpreters/detect.ts`).href
	);
	manager = await createCodemodeSessionManager({
		sessionId: "gate-imports",
		cwd: target,
		settings: defaultCodemodeSettings,
		availability: await getInterpreterAvailability(defaultCodemodeSettings, createInterpreterDetector()),
		executeTool: async () => { throw new GateInputError("unexpected import-census host call"); },
		complete: async () => { throw new GateInputError("unexpected import-census completion"); },
	});
	const kernel = await manager.getKernel("js", () => {});
	const result = await kernel.run({ cellId: "first", code: "1 + 1", timeoutMs: 180_000 });
	if (!result.ok) throw new TypeError(`Import census first cell failed: ${result.error.message}`);
	await manager.dispose();
	manager = undefined;
	// The probe must start cold in both the harness checkout and a separate --target.
	// Loading validation dependencies first would hide their transitive imports
	// only when the target shares the harness's module cache.
	delete process.env.SENPI_GATE_IMPORT_FILE;
	delete process.env.SENPI_GATE_IMPORT_PHASE;
	const { Check } = await import("typebox/value");
	const { importFrameSchema, moduleKey, scopeImports } = await import("./gate-import-scope.ts");
	const frames = [];
	let workerObserved = false;
	const trace = await readFile(path, "utf8").catch((error: unknown) => {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
		throw error;
	});
	for (const line of trace.split("\n").filter((entry) => entry.trim().length > 0)) {
		const entry: unknown = JSON.parse(line);
		if (!Check(importFrameSchema, entry)) throw new GateInputError("import observer frame");
		const key = moduleKey(entry.url);
		frames.push(entry);
		if (entry.thread !== 0) workerObserved = true;
		if (entry.url.startsWith("file:")) sizes[key] = (await stat(fileURLToPath(entry.url))).size;
	}
	if (!workerObserved) throw new GateInputError("import observer did not witness the kernel worker");
	const scoped = await scopeImports(target, frames);
	console.log(`GATE_SCOPED_IMPORTS:${JSON.stringify({ extension: scoped.extension, firstKernel: scoped.firstKernel })}`);
	console.log(`GATE_IMPORTS:${JSON.stringify({ ...scoped, sizes })}`);
} finally {
	try {
		await manager?.dispose();
	} finally {
		delete process.env.SENPI_GATE_IMPORT_FILE;
		delete process.env.SENPI_GATE_IMPORT_PHASE;
		await rm(root, { recursive: true, force: true });
	}
}
