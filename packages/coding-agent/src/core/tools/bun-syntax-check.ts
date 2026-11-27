import {
	createSyntaxChecker,
	type ScriptLoader,
	type ScriptParser,
	type SyntaxChecker,
	type SyntaxErrorReport,
} from "./syntax-check.ts";
import { lineAndColumn, utf16IndexOfUtf8Offset } from "./text-position.ts";

// The local edit and write tools check JS/TS with the parser the Bun runtime already ships, Bun.Transpiler. JSON is
// checked by the worker-safe core on every runtime; on Node only JSON is checked.

function numberField(value: unknown, key: string): number | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const field: unknown = Reflect.get(value, key);
	return typeof field === "number" ? field : undefined;
}

/**
 * Bun's `position` carries a UTF-8 byte `offset` and a 1-based line and column, and its column is one short after a
 * lone CR. The position is recomputed from the offset with the shared line rule where the lines agree; otherwise
 * Bun's own line and column stand (an end-of-file error sits at the end of the last line, not after its line break).
 */
function positionedReport(message: string, position: unknown, code: string): SyntaxErrorReport {
	const line = numberField(position, "line");
	const column = numberField(position, "column");
	const offset = numberField(position, "offset");
	const index = offset === undefined ? undefined : utf16IndexOfUtf8Offset(code, offset);
	const computed = index === undefined ? undefined : lineAndColumn(code, index, true);
	if (computed !== undefined && computed.line === line) return { message, ...computed };
	return line !== undefined && column !== undefined ? { message, line, column } : { message };
}

/** Bun reports exhausting its parser stack as a `BuildMessage` with the engine's RangeError text. */
const STACK_OVERFLOW_MESSAGE = "Maximum call stack size exceeded";

/**
 * A Bun.Transpiler syntax error is a `BuildMessage`, or an AggregateError of them when the parser reports several;
 * the first is the first error. A stack overflow says nothing about the syntax and gives no verdict.
 */
function transpilerErrorReport(error: unknown, code: string): SyntaxErrorReport | undefined {
	if (error instanceof AggregateError) {
		const errors: unknown = Reflect.get(error, "errors");
		return Array.isArray(errors) ? transpilerErrorReport(errors.at(0), code) : undefined;
	}
	if (!(error instanceof Error) || error.name !== "BuildMessage" || error.message === STACK_OVERFLOW_MESSAGE) {
		return undefined;
	}
	return positionedReport(error.message, Reflect.get(error, "position"), code);
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
			const report = transpilerErrorReport(error, code);
			return report === undefined ? undefined : { ok: false, error: report };
		}
	};
}

function runtimeBun(): unknown {
	return typeof process.versions.bun === "string" ? Reflect.get(globalThis, "Bun") : undefined;
}

/** `bun` is the `Bun` global of the running process by default; tests pass a stand-in. */
export function createLocalSyntaxChecker(bun: unknown = runtimeBun()): SyntaxChecker {
	if (typeof bun !== "object" || bun === null) return createSyntaxChecker();
	return createSyntaxChecker({ parseScript: bunScriptParser(bun) });
}
