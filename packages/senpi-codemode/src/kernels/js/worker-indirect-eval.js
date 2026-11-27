import { captureLastExpression, hasTopLevelReturn } from "./last-expression.js";
import { persistTopLevelDeclarations, USER_SCOPE } from "./persist-declarations.js";

// A cell may declare a name the kernel or the platform already defines (`const log = []`, `const fetch = ...`). The
// binding lives in a per-kernel user scope that later cells read through `with`, so it persists for the user's cells
// while the kernel, its prelude and imported libraries keep the original global. `delete <name>` in a cell restores it.
const USER_SCOPE_KEY = Symbol.for("senpi.kernel.userScope");

export function indirectEval(source, filename) {
	const withPragma = filename ? `${source}\n//# sourceURL=${filename}` : source;
	// oxlint-disable-next-line eslint/no-eval -- The persistent kernel evaluates user cells in global scope to retain their bindings.
	const geval = globalThis.eval;
	return geval(withPragma);
}

export async function awaitMaybePromise(value) {
	if (!value || typeof value !== "object" || typeof value.then !== "function") return value;
	return await value;
}

/** Wraps a cell for persistent evaluation; `shadowed` receives the kernel-global names the cell declares. */
export function wrapUserCode(code, shadowed = []) {
	const persistentCode = persistTopLevelDeclarations(code, shadowed);
	const body = hasTopLevelReturn(persistentCode) ? persistentCode : captureLastExpression(persistentCode);
	const scope = globalThis[USER_SCOPE_KEY];
	if (shadowed.length === 0 && (scope === undefined || Object.keys(scope).length === 0)) return `(async () => {\n${body}\n})()`;
	globalThis[USER_SCOPE_KEY] ??= Object.create(null);
	return `(async (${USER_SCOPE}) => { with (${USER_SCOPE}) { return await (async () => {\n${body}\n})(); } })(globalThis[Symbol.for("senpi.kernel.userScope")])`;
}
