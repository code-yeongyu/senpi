import {
	createSyntaxChecker,
	type JsonErrorLocator,
	type ScriptLoader,
	type ScriptParser,
	type SyntaxChecker,
	type SyntaxErrorReport,
} from "./syntax-check.ts";

// The local edit and write tools use the parsers the Bun runtime already ships: Bun.Transpiler for JS/TS, and the
// bundler's JSON loader to locate a JSON error that JSC's JSON.parse reports without a position. On Node only JSON is
// checked, and V8's JSON.parse message carries the position.

const VIRTUAL_JSON_PATH = "/senpi-syntax-check/content.json";

function numberField(value: unknown, key: string): number | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const field: unknown = Reflect.get(value, key);
	return typeof field === "number" ? field : undefined;
}

/** Bun reports a syntax error with `position` carrying a 1-based line and column. */
function positionedReport(message: string, position: unknown): SyntaxErrorReport {
	const line = numberField(position, "line");
	const column = numberField(position, "column");
	return line !== undefined && column !== undefined ? { message, line, column } : { message };
}

/** A Bun.Transpiler syntax error is a `BuildMessage`. */
function transpilerErrorReport(error: unknown): SyntaxErrorReport | undefined {
	if (!(error instanceof Error) || error.name !== "BuildMessage") return undefined;
	return positionedReport(error.message, Reflect.get(error, "position"));
}

function bunScriptParser(bun: object): ScriptParser | undefined {
	const Transpiler: unknown = Reflect.get(bun, "Transpiler");
	if (typeof Transpiler !== "function") return undefined;
	const transpilers = new Map<ScriptLoader, object>();
	const transpilerFor = (loader: ScriptLoader): object => {
		const cached = transpilers.get(loader);
		if (cached !== undefined) return cached;
		const created: object = Reflect.construct(Transpiler, [{ loader }]);
		transpilers.set(loader, created);
		return created;
	};
	return (code, loader) => {
		try {
			const transpiler = transpilerFor(loader);
			Reflect.apply(Reflect.get(transpiler, "scan"), transpiler, [code]);
			return { ok: true };
		} catch (error) {
			const report = transpilerErrorReport(error);
			return report === undefined ? undefined : { ok: false, error: report };
		}
	};
}

/** The first positioned error log of an in-memory Bun.build of the content as a .json entry; nothing is written. */
function bunJsonErrorLocator(bun: object): JsonErrorLocator | undefined {
	const build: unknown = Reflect.get(bun, "build");
	if (typeof build !== "function") return undefined;
	return async (content) => {
		try {
			const result: unknown = await Reflect.apply(build, bun, [
				{ entrypoints: [VIRTUAL_JSON_PATH], files: { [VIRTUAL_JSON_PATH]: content }, throw: false },
			]);
			const logs: unknown = typeof result === "object" && result !== null ? Reflect.get(result, "logs") : undefined;
			if (!Array.isArray(logs)) return undefined;
			for (const log of logs) {
				if (typeof log !== "object" || log === null || Reflect.get(log, "level") !== "error") continue;
				const message: unknown = Reflect.get(log, "message");
				const report = positionedReport(typeof message === "string" ? message : "", Reflect.get(log, "position"));
				if (report.line !== undefined && report.message !== "") return report;
			}
			return undefined;
		} catch {
			return undefined;
		}
	};
}

export function createLocalSyntaxChecker(): SyntaxChecker {
	const bun: unknown = typeof process.versions.bun === "string" ? Reflect.get(globalThis, "Bun") : undefined;
	if (typeof bun !== "object" || bun === null) return createSyntaxChecker();
	return createSyntaxChecker({ parseScript: bunScriptParser(bun), locateJsonError: bunJsonErrorLocator(bun) });
}
