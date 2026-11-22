import {
	createSyntaxChecker,
	type ScriptLoader,
	type ScriptParser,
	type SyntaxChecker,
	type SyntaxErrorReport,
} from "./syntax-check.ts";

// The local edit and write tools check JS/TS with the Bun.Transpiler the runtime already ships; on Node there is no
// such parser, so only JSON is checked there.

function numberField(value: unknown, key: string): number | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const field: unknown = Reflect.get(value, key);
	return typeof field === "number" ? field : undefined;
}

/** A Bun syntax error is a `BuildMessage` whose `position` carries a 1-based line and column. */
function syntaxErrorReport(error: unknown): SyntaxErrorReport | undefined {
	if (!(error instanceof Error) || error.name !== "BuildMessage") return undefined;
	const position: unknown = Reflect.get(error, "position");
	const line = numberField(position, "line");
	const column = numberField(position, "column");
	return line !== undefined && column !== undefined
		? { message: error.message, line, column }
		: { message: error.message };
}

function bunScriptParser(): ScriptParser | undefined {
	if (typeof process.versions.bun !== "string") return undefined;
	const bun: unknown = Reflect.get(globalThis, "Bun");
	if (typeof bun !== "object" || bun === null) return undefined;
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
			const report = syntaxErrorReport(error);
			return report === undefined ? undefined : { ok: false, error: report };
		}
	};
}

export function createLocalSyntaxChecker(): SyntaxChecker {
	return createSyntaxChecker(bunScriptParser());
}
