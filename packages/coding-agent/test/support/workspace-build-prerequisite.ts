/**
 * Declare and verify this suite's workspace-build prerequisite.
 *
 * Vitest resolves `@earendil-works/pi-ai` / `pi-tui` / `pi-agent-core` to the
 * sibling packages' TypeScript sources via the aliases in `vitest.base.ts`, so
 * in-process tests never need a build. The CHILD PROCESSES do: the spawned CLI
 * (`src/cli.ts` under tsx) and the worker fixtures resolve those same
 * specifiers through Node, which honours each manifest's `exports` map and
 * therefore requires the built `dist/*` entrypoints.
 *
 * When they are absent, the child dies during import — before reaching any
 * behavior under test — and the parent test reports only its downstream
 * symptom (`expected 1 to be +0`, an empty stdout, a missing log line). That
 * failure mode is unattributable at the assertion site, which is why the
 * suites that spawn such children opt into this check and it names the
 * prerequisite plus the exact command that satisfies it.
 *
 * The check is OPT-IN, called at the top of each dist-dependent test file, and
 * deliberately NOT part of the global `test/setup.ts`: CI's `Terminal tools`
 * job runs a small vitest subset (terminal extension, settings notify, shell
 * config kind) with no `npm run build` step, and those suites spawn no
 * workspace-resolving children — a global assertion would fail that job on
 * every OS. Every other CI vitest job builds the workspace first.
 *
 * Resolution goes through `import.meta.resolve`, not `require.resolve`: these
 * manifests export only the `import` condition, so a CJS-conditioned probe
 * would report a false negative for every specifier. Because
 * `import.meta.resolve` is spec-compliant and does not touch the filesystem,
 * the resolved target is then stat-ed — resolving a path proves the `exports`
 * map, not the build.
 *
 * FRESHNESS is separate and path-based: inside vitest every workspace
 * specifier is aliased to `src` even under `import.meta.resolve`, so a
 * resolver probe can never see the `dist` children load. Staleness is
 * therefore measured against the checkout that owns this module.
 */
import { type Dirent, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Specifiers that child processes resolve through Node's `exports` maps. */
const CHILD_PROCESS_SPECIFIERS = [
	"@earendil-works/pi-ai",
	"@earendil-works/pi-ai/compat",
	"@earendil-works/pi-ai/providers/cursor",
	"@earendil-works/pi-tui",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-agent-core/node",
] as const;

/**
 * Workspace packages whose built `dist` a child process imports. Existence is
 * not enough: a dist older than the package's newest source file means the
 * child still crashes at import on freshly added modules (observed: 31 suite
 * failures across 9 files from one stale `packages/ai/dist`).
 */
const FRESHNESS_PACKAGES = [
	{ name: "ai", dir: "packages/ai", specifier: "@earendil-works/pi-ai" },
	{ name: "agent", dir: "packages/agent", specifier: "@earendil-works/pi-agent-core" },
	{ name: "tui", dir: "packages/tui", specifier: "@earendil-works/pi-tui" },
	{ name: "pty", dir: "packages/pty", specifier: "@earendil-works/pi-pty" },
	{ name: "protocol", dir: "packages/protocol", specifier: "@earendil-works/pi-protocol" },
	{ name: "client", dir: "packages/client", specifier: "@earendil-works/pi-client" },
] as const;

interface WorkspacePackageRef {
	readonly name: string;
	readonly dir: string;
	readonly specifier: string;
}

/**
 * The package root whose `dist` spawned children of this suite actually
 * load: the workspace symlink under the CHECKOUT ROOT `node_modules` (where
 * Node's upward resolution lands for hoisted `@earendil-works/*` packages),
 * real-pathed. A git worktree that links the main checkout's `node_modules`
 * resolves to the MAIN package, which is exactly what its children import.
 * Falls back to the checkout-relative directory when no symlink exists.
 */
function resolveLoadedPackageRoot(pkg: WorkspacePackageRef, workspaceRoot: string): string {
	try {
		return realpathSync(join(workspaceRoot, "node_modules", pkg.specifier));
	} catch {
		return join(workspaceRoot, pkg.dir);
	}
}

/**
 * Find the repository root that owns this module: the first ancestor directory
 * containing the workspace manifest (`pnpm-workspace.yaml`). Returns undefined
 * when this file runs from outside a checkout (e.g. a copied fixture).
 */
function findWorkspaceRoot(startDir: string): string | undefined {
	let current = startDir;
	for (let depth = 0; depth < 8; depth += 1) {
		if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
	return undefined;
}

/** Newest file mtime (ms) under `dir`, or 0 when the directory is missing/empty. */
function newestMtimeMs(dir: string): number {
	let newest = 0;
	const stack = [dir];
	while (stack.length > 0) {
		const current = stack.pop() as string;
		let entries: Dirent[];
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
				continue;
			}
			try {
				const mtimeMs = statSync(full).mtimeMs;
				if (mtimeMs > newest) newest = mtimeMs;
			} catch {}
		}
	}
	return newest;
}

export interface WorkspacePackageFreshness {
	readonly stale: boolean;
	readonly srcNewestMs: number;
	readonly distNewestMs: number;
}

/**
 * A package is stale when its built output is missing, empty, or predates its
 * newest source file. Equal mtimes count as fresh: `npm run build` rewrites
 * the entrypoint last, so `dist >= src` holds for a correct build.
 */
export function isWorkspacePackageStale(rootDir: string): WorkspacePackageFreshness {
	const srcNewestMs = newestMtimeMs(join(rootDir, "src"));
	const distNewestMs = newestMtimeMs(join(rootDir, "dist"));
	return { stale: distNewestMs < srcNewestMs, srcNewestMs, distNewestMs };
}

/**
 * Staleness (package name) per entry, measured against the package root whose
 * built `dist` the spawned children of `parentUrl`'s checkout actually load —
 * not through Node resolution (vitest aliases make every workspace specifier
 * resolve to `src`, so a resolver probe can never see the loaded `dist`).
 */
export function findStaleWorkspacePackages(
	parentUrl: string,
	packages: readonly WorkspacePackageRef[] = FRESHNESS_PACKAGES,
	workspaceRoot = findWorkspaceRoot(dirname(fileURLToPath(parentUrl))),
): string[] {
	if (workspaceRoot === undefined) return [];
	const stale: string[] = [];
	for (const pkg of packages) {
		// Two roots can disagree: children that resolve through the hoisted root
		// `node_modules` load the realpathed package (a linked worktree loads the
		// main checkout's dist), while suite-local import hooks and checkout-
		// relative resolution load the checkout's own `packages/<dir>`. A stale
		// build in EITHER root crashes children, so both must be fresh.
		const loadedRoot = resolveLoadedPackageRoot(pkg, workspaceRoot);
		const checkoutRoot = join(workspaceRoot, pkg.dir);
		if (loadedRoot !== checkoutRoot) {
			if (isWorkspacePackageStale(loadedRoot).stale || isWorkspacePackageStale(checkoutRoot).stale) {
				stale.push(pkg.name);
			}
		} else if (isWorkspacePackageStale(loadedRoot).stale) {
			stale.push(pkg.name);
		}
	}
	return stale;
}

/** Throws an actionable error when a checked workspace package carries a stale dist. */
export function assertStaleWorkspacePackages(
	packages: readonly { readonly name: string; readonly rootDir: string }[],
): void {
	const stale = packages.filter((pkg) => isWorkspacePackageStale(pkg.rootDir).stale).map((pkg) => pkg.name);
	if (stale.length === 0) return;
	throw new Error(
		`Unmet test prerequisite: the workspace build is stale — ${stale.join(", ")} have source files ` +
			`newer than their built dist, so child-process tests will crash at import. ` +
			`Run \`npm run build\` from the repository root, then re-run this suite.`,
	);
}

/**
 * Returns the specifiers whose built entrypoint cannot be resolved from
 * `parentUrl`. Resolution goes through Node's own ESM resolver rather than a
 * hardcoded `dist/index.js` guess, so this asserts exactly what an ESM child
 * process will do.
 */
export function findUnbuiltWorkspaceSpecifiers(parentUrl: string): string[] {
	const missing: string[] = [];
	for (const specifier of CHILD_PROCESS_SPECIFIERS) {
		try {
			if (!existsSync(fileURLToPath(import.meta.resolve(specifier, parentUrl)))) missing.push(specifier);
		} catch {
			missing.push(specifier);
		}
	}
	return missing;
}

/** Throws an actionable error when the workspace build prerequisite is unmet. */
export function assertWorkspaceBuildPrerequisite(parentUrl: string): void {
	const missing = findUnbuiltWorkspaceSpecifiers(parentUrl);
	if (missing.length > 0) {
		throw new Error(
			`Unmet test prerequisite: the workspace packages are not built, so child-process tests ` +
				`(spawned CLI, worker fixtures) cannot resolve ${missing.join(", ")}. ` +
				`Run \`npm run build\` from the repository root, then re-run this suite.`,
		);
	}
	const stale = findStaleWorkspacePackages(parentUrl);
	if (stale.length > 0) {
		throw new Error(
			`Unmet test prerequisite: the workspace build is stale — ${stale.join(", ")} have source files ` +
				`newer than their built dist, so child-process tests crash at import ` +
				`(e.g. a provider module added after the last build). ` +
				`Run \`npm run build\` from the repository root, then re-run this suite.`,
		);
	}
}
