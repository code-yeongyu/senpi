// The classic TypeScript API (createProgram, the checker, the AST guards below) no longer
// ships in the root `typescript` package (typescript-Go 7.x exports version info only), so
// this walk imports it from @typescript/typescript6 - the same pattern the repo's
// scripts/check-ts-relative-imports.mjs and scripts/check-runtime-deps.mjs already use.
import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "@typescript/typescript6";

/**
 * Files whose functions seed the session-path call graph: everything a routed RPC
 * command can reach while the host event loop is held. `src/core/tools` is expanded
 * to every tool implementation.
 */
export const SESSION_PATH_ROOT_FILES = [
	"src/modes/rpc/session-registry.ts",
	"src/modes/rpc/session-binding.ts",
	"src/modes/rpc/connection-handler.ts",
	"src/modes/rpc/session-command-router.ts",
	"src/core/agent-session.ts",
	"src/core/auth-storage.ts",
] as const;

/** Root directory expanded to all of its `.ts` sources. */
export const SESSION_PATH_ROOT_DIRECTORY = "src/core/tools";

/** Blocking primitives written as a bare or member call: `spawnSync(...)`, `cp.spawnSync(...)`. */
const BLOCKING_CALLEES = new Set(["execSync", "execFileSync", "spawnSync"]);
/** Blocking primitives that only exist in qualified form. */
const QUALIFIED_BLOCKING_CALLEES = new Set(["Atomics.wait", "Bun.spawnSync", "Bun.sleepSync"]);
/** Synchronous filesystem calls: reported against a ledger, never banned outright. */
const SYNC_FS_CALLEES = new Set(["readFileSync", "writeFileSync", "appendFileSync"]);

export type SessionPathFindingKind = "blocking" | "sync-fs";

/** One (file, api, enclosing function) call site group found on the session path. */
export interface SessionPathFinding {
	readonly kind: SessionPathFindingKind;
	/** Package-relative path, POSIX separators. */
	readonly file: string;
	/** The call as written (`spawnSync`, `Atomics.wait`, `fs.readFileSync`). */
	readonly api: string;
	/** Enclosing function, method or `<module>` for top-level code. */
	readonly symbol: string;
	readonly count: number;
	/** Informational only: line numbers move with unrelated edits and are never compared. */
	readonly lines: readonly number[];
}

export interface SessionPathAuditOptions {
	readonly packageRoot: string;
	/** Extra call-graph roots. The audit's own can-fail proof seeds a fixture through this. */
	readonly extraRoots?: readonly string[];
}

type FunctionLike =
	| ts.FunctionDeclaration
	| ts.MethodDeclaration
	| ts.ArrowFunction
	| ts.FunctionExpression
	| ts.ConstructorDeclaration
	| ts.GetAccessorDeclaration
	| ts.SetAccessorDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLike {
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

function collectTypeScriptSources(directory: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(directory)) {
		const full = join(directory, entry);
		if (statSync(full).isDirectory()) found.push(...collectTypeScriptSources(full));
		else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) found.push(full);
	}
	return found;
}

export function sessionPathRoots(packageRoot: string): string[] {
	return [
		...SESSION_PATH_ROOT_FILES.map((file) => resolve(packageRoot, file)),
		...collectTypeScriptSources(resolve(packageRoot, SESSION_PATH_ROOT_DIRECTORY)),
	];
}

function createProgram(packageRoot: string, roots: readonly string[]): ts.Program {
	const configPath = resolve(packageRoot, "tsconfig.build.json");
	const config = ts.readConfigFile(configPath, ts.sys.readFile);
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageRoot);
	return ts.createProgram({
		rootNames: [...roots],
		options: { ...parsed.options, noEmit: true, declaration: false, sourceMap: false, skipLibCheck: true },
	});
}

/** Every function-like node below `node`, nested closures included. */
function functionsOf(node: ts.Node): FunctionLike[] {
	const found: FunctionLike[] = [];
	const visit = (child: ts.Node): void => {
		if (isFunctionLike(child)) found.push(child);
		ts.forEachChild(child, visit);
	};
	visit(node);
	return found;
}

/**
 * Calls in a function body, nested closures included: a closure declared here can run
 * on this path, so the walk stays conservative rather than losing the callback seam
 * that most blocking work hides behind. For a source file only top-level statements
 * count - its functions are separate graph nodes.
 */
function callsIn(node: ts.Node): (ts.CallExpression | ts.NewExpression)[] {
	const found: (ts.CallExpression | ts.NewExpression)[] = [];
	const visit = (child: ts.Node): void => {
		if (ts.isCallExpression(child) || ts.isNewExpression(child)) found.push(child);
		ts.forEachChild(child, visit);
	};
	if (ts.isSourceFile(node)) {
		for (const statement of node.statements) if (!isFunctionLike(statement)) visit(statement);
		return found;
	}
	visit(node);
	return found;
}

function declarationsOf(checker: ts.TypeChecker, callee: ts.Expression): readonly ts.Declaration[] {
	const symbol = checker.getSymbolAtLocation(callee);
	if (!symbol) return [];
	const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
	return target.declarations ?? [];
}

/** Call targets that are themselves source functions, so the walk can follow them. */
function targetsOf(declaration: ts.Declaration): FunctionLike[] {
	if (isFunctionLike(declaration)) return [declaration];
	if (ts.isClassDeclaration(declaration)) return functionsOf(declaration);
	if (ts.isVariableDeclaration(declaration) && declaration.initializer && isFunctionLike(declaration.initializer))
		return [declaration.initializer];
	return [];
}

function reachableNodes(program: ts.Program, checker: ts.TypeChecker, roots: ReadonlySet<string>): Set<ts.Node> {
	const sources = new Set(
		program
			.getSourceFiles()
			.filter((file) => !file.isDeclarationFile)
			.map((file) => resolve(file.fileName)),
	);
	const seeds: ts.Node[] = [];
	for (const source of program.getSourceFiles()) {
		if (!roots.has(resolve(source.fileName))) continue;
		seeds.push(source, ...functionsOf(source));
	}
	const reachable = new Set<ts.Node>(seeds);
	const queue = [...seeds];
	while (queue.length > 0) {
		const current = queue.shift();
		if (current === undefined) continue;
		for (const call of callsIn(current)) {
			for (const declaration of declarationsOf(checker, call.expression)) {
				if (!sources.has(resolve(declaration.getSourceFile().fileName))) continue;
				for (const target of targetsOf(declaration)) {
					if (reachable.has(target)) continue;
					reachable.add(target);
					queue.push(target);
				}
			}
		}
	}
	return reachable;
}

/** Nearest enclosing function, method, or `<module>`; `<anonymous>` for an unnamed closure. */
function enclosingSymbol(node: ts.Node): string {
	for (let current: ts.Node | undefined = node; current; current = current.parent) {
		if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current))
			return current.name?.getText() ?? "<anonymous>";
		if (ts.isConstructorDeclaration(current)) return "constructor";
		if (ts.isGetAccessorDeclaration(current) || ts.isSetAccessorDeclaration(current)) return current.name.getText();
		if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
			const parent = current.parent;
			if (ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertyAssignment(parent))
				return parent.name.getText();
			continue;
		}
		if (ts.isSourceFile(current)) return "<module>";
	}
	return "<anonymous>";
}

/**
 * Classify one call. A callee declared in this package's own sources is never a finding:
 * the walk follows it instead, so a helper named `readFileSync` is judged by what it does.
 * Aliased imports (`spawnSync as nodeSpawnSync`) are resolved back to their declared name.
 */
function classify(
	checker: ts.TypeChecker,
	call: ts.CallExpression,
	sources: ReadonlySet<string>,
): { kind: SessionPathFindingKind; api: string } | undefined {
	const callee = call.expression;
	if (!ts.isIdentifier(callee) && !ts.isPropertyAccessExpression(callee)) return undefined;
	const written = callee.getText();
	if (QUALIFIED_BLOCKING_CALLEES.has(written)) return { kind: "blocking", api: written };
	const declarations = declarationsOf(checker, callee);
	if (declarations.some((declaration) => sources.has(resolve(declaration.getSourceFile().fileName)))) return undefined;
	const name = symbolName(checker, callee) ?? (ts.isPropertyAccessExpression(callee) ? callee.name.text : written);
	if (BLOCKING_CALLEES.has(name)) return { kind: "blocking", api: written };
	if (SYNC_FS_CALLEES.has(name)) return { kind: "sync-fs", api: written };
	return undefined;
}

/** Declared name behind an import alias (`spawnSync as nodeSpawnSync` -> `spawnSync`). */
function symbolName(checker: ts.TypeChecker, callee: ts.Expression): string | undefined {
	const symbol = checker.getSymbolAtLocation(callee);
	if (!symbol) return undefined;
	const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
	return target.getName();
}

/**
 * Walk the transitive call graph rooted at the session path and report every blocking
 * primitive and synchronous filesystem call it can reach.
 */
export function auditSessionPath(options: SessionPathAuditOptions): readonly SessionPathFinding[] {
	const packageRoot = resolve(options.packageRoot);
	const roots = [...sessionPathRoots(packageRoot), ...(options.extraRoots ?? []).map((root) => resolve(root))];
	const program = createProgram(packageRoot, roots);
	const checker = program.getTypeChecker();
	const sources = new Set(
		program
			.getSourceFiles()
			.filter((file) => !file.isDeclarationFile)
			.map((file) => resolve(file.fileName)),
	);
	const grouped = new Map<string, { finding: SessionPathFinding; lines: number[] }>();
	for (const node of reachableNodes(program, checker, new Set(roots))) {
		for (const call of callsIn(node)) {
			if (!ts.isCallExpression(call)) continue;
			const classified = classify(checker, call, sources);
			if (!classified) continue;
			const source = call.getSourceFile();
			const file = relative(packageRoot, source.fileName).split("\\").join("/");
			const symbol = enclosingSymbol(call);
			const key = `${classified.kind}|${file}|${classified.api}|${symbol}`;
			const line = source.getLineAndCharacterOfPosition(call.getStart()).line + 1;
			const existing = grouped.get(key);
			if (existing) {
				if (!existing.lines.includes(line)) existing.lines.push(line);
				continue;
			}
			grouped.set(key, {
				lines: [line],
				finding: { kind: classified.kind, file, api: classified.api, symbol, count: 0, lines: [] },
			});
		}
	}
	return [...grouped.values()]
		.map(({ finding, lines }) => ({ ...finding, count: lines.length, lines: [...lines].sort((a, b) => a - b) }))
		.sort((left, right) => findingKey(left).localeCompare(findingKey(right)));
}

export function findingKey(finding: Pick<SessionPathFinding, "file" | "api" | "symbol">): string {
	return `${finding.file}|${finding.api}|${finding.symbol}`;
}
