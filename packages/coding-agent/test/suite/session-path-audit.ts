// The classic TypeScript API (createProgram, the checker, the AST guards below) no longer
// ships in the root `typescript` package (typescript-Go 7.x exports version info only), so
// this walk imports it from @typescript/typescript6 - the same pattern the repo's
// scripts/check-ts-relative-imports.mjs and scripts/check-runtime-deps.mjs already use.
import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "@typescript/typescript6";
import {
	classify,
	declarationsOf,
	type FunctionLike,
	isFunctionLike,
	type SessionPathFindingKind,
} from "./session-path-classify.ts";

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

/**
 * The recovery owner and the fanout that produces its admissions (senpi#4272 S08a, RULING-50 (3)): they expose no
 * synchronous byte path; the pinned transcript's sync reader stays out of them until S11's asynchronous page route.
 */
export const RECOVERY_PATH_FILES = [
	"src/modes/rpc/session-event-fanout.ts",
	"src/modes/rpc/compact-recovery-state.ts",
	"src/modes/rpc/compact-recovery-types.ts",
] as const;

/** Root directory expanded to all of its `.ts` sources. */
export const SESSION_PATH_ROOT_DIRECTORY = "src/core/tools";

/**
 * The move feature's own code: every module under `src/core/session-move`, the RPC `move_session` commands and the
 * rebind an import commits through. Nothing in these files may call synchronous I/O, and no ledger entry may name one.
 */
export const MOVE_PATH_DIRECTORY = "src/core/session-move";
export const MOVE_PATH_EXTRA_FILES = ["src/modes/rpc/session-move-commands.ts", "src/core/session-rebind.ts"] as const;

export type { SessionPathFindingKind };

/** One (file, api, enclosing function) call site group found on the session path. */
export interface SessionPathFinding {
	readonly kind: SessionPathFindingKind;
	/** Package-relative path, POSIX separators. */
	readonly file: string;
	/** The call as written (`spawnSync`, `Atomics.wait`, `fs.readFileSync`). */
	readonly api: string;
	/** The declared name behind it, through the alias forms the classifier follows (`copyInPlace` -> `copyFileSync`). */
	readonly callee: string;
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
	/** Replaces the session-path roots, so one sub-path (the move path) can be audited on its own. */
	readonly roots?: readonly string[];
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

/** Package-relative move-path files, POSIX separators. */
export function movePathFiles(packageRoot: string): string[] {
	const root = resolve(packageRoot);
	return [
		...collectTypeScriptSources(resolve(root, MOVE_PATH_DIRECTORY)).map((file) =>
			relative(root, file).split("\\").join("/"),
		),
		...MOVE_PATH_EXTRA_FILES,
	];
}

export function sessionPathRoots(packageRoot: string): string[] {
	return [
		...[...SESSION_PATH_ROOT_FILES, ...RECOVERY_PATH_FILES].map((file) => resolve(packageRoot, file)),
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
 * Walk the transitive call graph rooted at the session path and report every blocking
 * primitive and synchronous filesystem call it can reach.
 */
export function auditSessionPath(options: SessionPathAuditOptions): readonly SessionPathFinding[] {
	const packageRoot = resolve(options.packageRoot);
	const roots = [
		...(options.roots ?? sessionPathRoots(packageRoot)).map((root) => resolve(packageRoot, root)),
		...(options.extraRoots ?? []).map((root) => resolve(root)),
	];
	const program = createProgram(packageRoot, roots);
	const checker = program.getTypeChecker();
	const sources = new Set(
		program
			.getSourceFiles()
			.filter((file) => !file.isDeclarationFile)
			.map((file) => resolve(file.fileName)),
	);
	const grouped = new Map<string, { finding: SessionPathFinding; sites: Map<number, number> }>();
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
			// One count per call site: a closure is walked both as its own node and inside its parent.
			const group = grouped.get(key) ?? {
				finding: { ...classified, file, symbol, count: 0, lines: [] },
				sites: new Map(),
			};
			group.sites.set(call.getStart(), line);
			grouped.set(key, group);
		}
	}
	return [...grouped.values()]
		.map(({ finding, sites }) => ({
			...finding,
			count: sites.size,
			lines: [...new Set(sites.values())].sort((a, b) => a - b),
		}))
		.sort((left, right) => compareCodepoints(findingKey(left), findingKey(right)));
}

/** Locale-independent order, so a regenerated baseline sorts the same on every machine. */
export function compareCodepoints(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

export function findingKey(finding: Pick<SessionPathFinding, "file" | "api" | "symbol">): string {
	return `${finding.file}|${finding.api}|${finding.symbol}`;
}
