import {
	createSyntaxChecker,
	type ScriptLoader,
	type ScriptParser,
	type SyntaxChecker,
	type SyntaxErrorReport,
} from "./syntax-check.ts";

// The local edit and write tools check JS/TS with the parser the Bun runtime already ships, Bun.Transpiler. JSON is
// checked by the worker-safe core on every runtime; on Node only JSON is checked.

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

export function createLocalSyntaxChecker(): SyntaxChecker {
	const bun: unknown = typeof process.versions.bun === "string" ? Reflect.get(globalThis, "Bun") : undefined;
	if (typeof bun !== "object" || bun === null) return createSyntaxChecker();
	return createSyntaxChecker({ parseScript: bunScriptParser(bun) });
}
