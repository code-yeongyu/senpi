import { resolve } from "node:path";
import ts from "@typescript/typescript6";

/**
 * What one call on the session path is: a blocking primitive, a synchronous fs/crypto/zlib call, or neither.
 *
 * This is a ratchet lint against accidental synchronous I/O, not a security boundary. It resolves the forms people
 * actually write back to the declaring module: imports in every shape (named, aliased, default, namespace, dynamic,
 * re-exported), destructuring from a module binding (`const { copyFileSync } = fs`), a renamed alias
 * (`const read = fs.readFileSync`), `.bind`/`.call`/`.apply` on the function, and `require("fs")` /
 * `createRequire(url)("node:fs")`.
 *
 * Deliberately out of scope, because each needs data-flow analysis for a form nobody writes by accident:
 * - a function passed by reference and called elsewhere (`paths.filter(existsSync)`);
 * - computed element access (`fs["existsSync"](...)`, `fs[name](...)`);
 * - `eval`, `new Function`, `Reflect.apply`, and other reflective calls;
 * - a binding reassigned after declaration (`let read; read = fs.readFileSync`) or stored on an object
 *   (`ops.read = fs.readFileSync; ops.read()`), or a function received as a parameter.
 */

/** Blocking primitives written as a bare or member call: `spawnSync(...)`, `cp.spawnSync(...)`. */
const BLOCKING_CALLEES = new Set(["execSync", "execFileSync", "spawnSync"]);
/** Blocking primitives that only exist in qualified form. */
const QUALIFIED_BLOCKING_CALLEES = new Set(["Atomics.wait", "Bun.spawnSync", "Bun.sleepSync"]);
/** Every `*Sync` export of these modules counts: `openSync`, `readSync`, `copyFileSync`, `cpSync`, `gzipSync`, ... */
const SYNC_IO_MODULES = new Set(["fs", "node:fs", "crypto", "node:crypto", "zlib", "node:zlib"]);
/** How deep an alias chain (`const b = a.bind(x)` over `const a = fs.readFileSync`) is followed. */
const MAX_ALIAS_DEPTH = 4;

export type SessionPathFindingKind = "blocking" | "sync-fs";

export type FunctionLike =
	| ts.FunctionDeclaration
	| ts.MethodDeclaration
	| ts.ArrowFunction
	| ts.FunctionExpression
	| ts.ConstructorDeclaration
	| ts.GetAccessorDeclaration
	| ts.SetAccessorDeclaration;

export function isFunctionLike(node: ts.Node): node is FunctionLike {
	return (
		ts.isFunctionDeclaration(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isArrowFunction(node) ||
		ts.isFunctionExpression(node) ||
		ts.isConstructorDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node)
	);
}

export function declarationsOf(checker: ts.TypeChecker, callee: ts.Expression): readonly ts.Declaration[] {
	const symbol = checker.getSymbolAtLocation(callee);
	if (!symbol) return [];
	const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
	return target.declarations ?? [];
}

/**
 * Classify one call. A callee declared as a function in this package's own sources is never a finding: the walk
 * follows it instead, so a helper named `readFileSync` is judged by what it does.
 */
export function classify(
	checker: ts.TypeChecker,
	call: ts.CallExpression,
	sources: ReadonlySet<string>,
): { kind: SessionPathFindingKind; api: string; callee: string } | undefined {
	const callee = call.expression;
	const written = callee.getText();
	if (QUALIFIED_BLOCKING_CALLEES.has(written)) return { kind: "blocking", api: written, callee: written };
	const target = invokedFunction(callee);
	if (!ts.isIdentifier(target) && !ts.isPropertyAccessExpression(target)) return undefined;
	const declarations = declarationsOf(checker, target);
	if (declarations.some((declaration) => isOwnFunction(declaration, sources))) return undefined;
	const name = symbolName(checker, target) ?? (ts.isPropertyAccessExpression(target) ? target.name.text : written);
	if (BLOCKING_CALLEES.has(name)) return { kind: "blocking", api: written, callee: name };
	const syncName = syncIoName(checker, target, 0);
	return syncName === undefined ? undefined : { kind: "sync-fs", api: written, callee: syncName };
}

/** The function a call runs: `f.call(...)`/`f.apply(...)` and `f.bind(x)(...)` run `f`. */
function invokedFunction(callee: ts.Expression): ts.Expression {
	if (ts.isPropertyAccessExpression(callee) && (callee.name.text === "call" || callee.name.text === "apply"))
		return unbound(callee.expression);
	return unbound(callee);
}

/** `f.bind(x)` is `f`; anything else is itself. */
function unbound(expression: ts.Expression): ts.Expression {
	const inner = ts.isParenthesizedExpression(expression) ? expression.expression : expression;
	if (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression))
		if (inner.expression.name.text === "bind") return unbound(inner.expression.expression);
	return inner;
}

function isOwnFunction(declaration: ts.Declaration, sources: ReadonlySet<string>): boolean {
	if (!sources.has(resolve(declaration.getSourceFile().fileName))) return false;
	if (ts.isVariableDeclaration(declaration))
		return !!declaration.initializer && isFunctionLike(declaration.initializer);
	return !ts.isBindingElement(declaration);
}

/** The `*Sync` name a callee resolves to in a sync-I/O module, through the alias forms this lint follows. */
function syncIoName(checker: ts.TypeChecker, target: ts.Expression, depth: number): string | undefined {
	if (depth > MAX_ALIAS_DEPTH) return undefined;
	if (ts.isPropertyAccessExpression(target) && requiresSyncIoModule(checker, target.expression, depth))
		return target.name.text.endsWith("Sync") ? target.name.text : undefined;
	for (const declaration of declarationsOf(checker, target)) {
		if (declaredInSyncIoModule(declaration)) {
			const name = symbolName(checker, target) ?? "";
			return name.endsWith("Sync") ? name : undefined;
		}
		if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name) && declaration.initializer) {
			const source = unbound(declaration.initializer);
			if (ts.isIdentifier(source) || ts.isPropertyAccessExpression(source))
				return syncIoName(checker, source, depth + 1);
		}
		if (ts.isBindingElement(declaration)) return destructuredSyncName(checker, declaration);
	}
	return undefined;
}

/** `const { copyFileSync } = fs` (or `{ copyFileSync: copy }`): the property, looked up on the bound value's type. */
function destructuredSyncName(checker: ts.TypeChecker, element: ts.BindingElement): string | undefined {
	const pattern = element.parent;
	if (!ts.isObjectBindingPattern(pattern) || !ts.isVariableDeclaration(pattern.parent)) return undefined;
	const bound = pattern.parent.initializer;
	const property = (element.propertyName ?? element.name).getText();
	if (!bound || !property.endsWith("Sync")) return undefined;
	const symbol = checker.getPropertyOfType(checker.getTypeAtLocation(bound), property);
	return symbol?.declarations?.some(declaredInSyncIoModule) ? property : undefined;
}

/**
 * Whether an expression is a sync-I/O module loaded by `require`: `require("fs")`, `createRequire(url)("node:fs")`,
 * or a variable initialised with either. Their result is untyped, so the module is read from the string argument.
 */
function requiresSyncIoModule(checker: ts.TypeChecker, expression: ts.Expression, depth: number): boolean {
	if (depth > MAX_ALIAS_DEPTH) return false;
	if (ts.isCallExpression(expression)) {
		const [specifier] = expression.arguments;
		return (
			expression.arguments.length === 1 &&
			specifier !== undefined &&
			ts.isStringLiteral(specifier) &&
			SYNC_IO_MODULES.has(specifier.text) &&
			isRequire(checker, expression.expression, depth)
		);
	}
	if (!ts.isIdentifier(expression)) return false;
	return declarationsOf(checker, expression).some(
		(declaration) =>
			ts.isVariableDeclaration(declaration) &&
			!!declaration.initializer &&
			requiresSyncIoModule(checker, declaration.initializer, depth + 1),
	);
}

/** `require`, `createRequire(url)`, or a variable holding `createRequire(url)`. */
function isRequire(checker: ts.TypeChecker, callee: ts.Expression, depth: number): boolean {
	if (ts.isIdentifier(callee) && callee.text === "require") return true;
	if (ts.isCallExpression(callee)) return symbolName(checker, callee.expression) === "createRequire";
	if (!ts.isIdentifier(callee) || depth > MAX_ALIAS_DEPTH) return false;
	return declarationsOf(checker, callee).some(
		(declaration) =>
			ts.isVariableDeclaration(declaration) &&
			!!declaration.initializer &&
			isRequire(checker, declaration.initializer, depth + 1),
	);
}

/** Whether a declaration sits inside `declare module "fs"` (or another module in `SYNC_IO_MODULES`). */
function declaredInSyncIoModule(declaration: ts.Declaration): boolean {
	for (let current: ts.Node | undefined = declaration; current; current = current.parent) {
		if (ts.isModuleDeclaration(current) && ts.isStringLiteral(current.name))
			return SYNC_IO_MODULES.has(current.name.text);
	}
	return false;
}

/** Declared name behind an import alias (`spawnSync as nodeSpawnSync` -> `spawnSync`). */
function symbolName(checker: ts.TypeChecker, callee: ts.Expression): string | undefined {
	const symbol = checker.getSymbolAtLocation(callee);
	if (!symbol) return undefined;
	const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
	return target.getName();
}
