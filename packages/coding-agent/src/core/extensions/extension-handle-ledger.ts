import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isSyntheticPath } from "../source-info.ts";
import {
	type HandleOwner,
	handleOwnerStore,
	installHandleTracking,
	type OwnedHandleKind,
} from "./extension-handle-tracking.ts";
import type { Extension } from "./types.ts";

/**
 * Per extension instance: the handles its code created and has not released yet.
 * `reclaim()` runs once, after the instance's `session_shutdown` handlers, and closes
 * whatever is still open (senpi#2292). A closed ledger records nothing new.
 */
class ExtensionHandleLedger implements HandleOwner {
	private readonly open = new Set<{ readonly kind: OwnedHandleKind; readonly release: () => void }>();
	private closed = false;

	private readonly ownsPath: (creatorPath: string) => boolean;

	constructor(ownsPath: (creatorPath: string) => boolean) {
		this.ownsPath = ownsPath;
	}

	ownsCreatorFrame(creatorPath: string): boolean {
		return !this.closed && this.ownsPath(creatorPath);
	}

	track(kind: OwnedHandleKind, release: () => void): () => void {
		const handle = { kind, release };
		this.open.add(handle);
		return () => {
			this.open.delete(handle);
		};
	}

	reclaim(): { readonly counts: Readonly<Record<OwnedHandleKind, number>>; readonly failures: readonly string[] } {
		this.closed = true;
		const counts: Record<OwnedHandleKind, number> = { server: 0, socket: 0, timer: 0 };
		const failures: string[] = [];
		for (const handle of this.open) {
			try {
				handle.release();
				counts[handle.kind]++;
			} catch (error) {
				failures.push(`${handle.kind}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		this.open.clear();
		return { counts, failures };
	}
}

function isInside(child: string, parent: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Both spellings of a path: Bun's stack frames name real paths, Node's name the path a module was
 * imported by, so a path reached through a symlink (macOS `/tmp`, a symlinked checkout) can appear as either.
 */
function spellings(location: string): readonly string[] {
	try {
		const real = realpathSync(location);
		return real === location ? [location] : [location, real];
	} catch {
		return [location];
	}
}

const isInsideAny = (child: string, parents: readonly string[]) => parents.some((parent) => isInside(child, parent));

/**
 * Where senpi's own code lives, never an extension's: the monorepo `packages/` directory (or this package
 * alone when installed), the scoped packages senpi publishes, and a compiled binary's embedded filesystem.
 */
const SENPI_ROOTS = (() => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	if (!here.endsWith(path.join("core", "extensions"))) return spellings(here);
	const packageRoot = path.resolve(here, "..", "..", "..");
	const workspace = path.dirname(packageRoot);
	return spellings(path.basename(workspace) === "packages" ? workspace : packageRoot);
})();
const SENPI_PACKAGE_SEGMENT =
	/[\\/]node_modules[\\/]@(?:earendil-works|code-yeongyu)[\\/]|^\/\$bunfs\/|^[A-Za-z]:[\\/]~BUN[\\/]/;

const isSenpiCode = (creatorPath: string): boolean =>
	SENPI_PACKAGE_SEGMENT.test(creatorPath) || isInsideAny(creatorPath, SENPI_ROOTS);

/**
 * What a file extension's own code is: its directory when the extension is a directory extension (a
 * `package.json` beside its entry, or an `index.*` entry as in `extensions/<name>/index.ts`), otherwise its
 * entry file alone, so a single-file extension never owns what a neighbour in a shared extensions directory
 * creates. Senpi's code is excluded either way.
 */
const INDEX_ENTRY = /^index\.[cm]?[jt]sx?$/;

function ownershipTest(extension: Extension): (creatorPath: string) => boolean {
	const directory = path.dirname(extension.resolvedPath);
	const isDirectoryExtension =
		INDEX_ENTRY.test(path.basename(extension.resolvedPath)) || existsSync(path.join(directory, "package.json"));
	const owned = spellings(isDirectoryExtension ? directory : extension.resolvedPath);
	return (creatorPath) => isInsideAny(creatorPath, owned) && !isSenpiCode(creatorPath);
}

const ledgers = new WeakMap<Extension, ExtensionHandleLedger>();

/**
 * Builtin extensions are senpi's own code and manage their handles themselves. An inline factory (a synthetic
 * path such as `<inline>`) has no code location to tell its own handles from the senpi code it calls, so it is
 * not tracked either. Decided by the path, not `sourceInfo`: the resource loader relabels `sourceInfo` after
 * the factory ran (a `-e` file becomes source `cli` with no `baseDir`).
 */
const isUntracked = (extension: Extension): boolean =>
	extension.sourceInfo.source === "builtin" || isSyntheticPath(extension.path);

function ledgerFor(extension: Extension): ExtensionHandleLedger | undefined {
	if (isUntracked(extension)) return undefined;
	let ledger = ledgers.get(extension);
	if (ledger === undefined) {
		ledger = new ExtensionHandleLedger(ownershipTest(extension));
		ledgers.set(extension, ledger);
	}
	return ledger;
}

/** Runs `task` as `extension`'s code: servers, sockets and timers it creates are recorded for it. */
export function runOwnedBy<T>(extension: Extension, task: () => T): T {
	const ledger = ledgerFor(extension);
	if (ledger === undefined) return task();
	installHandleTracking();
	return handleOwnerStore.run(ledger, task);
}

/** `fn`, entered as `extension`'s code on every call; builtins get `fn` itself back. */
export function ownedBy<This, Args extends unknown[], Result>(
	extension: Extension,
	fn: (this: This, ...args: Args) => Result,
): (this: This, ...args: Args) => Result {
	if (isUntracked(extension)) return fn;
	return function (this: This, ...args: Args): Result {
		return runOwnedBy(extension, () => fn.apply(this, args));
	};
}

const runnerExtensions = new WeakMap<object, readonly Extension[]>();

/** Called by `ExtensionRunner`'s constructor: the instances `reclaimRunnerHandles` closes for that runner. */
export function registerRunnerExtensions(runner: object, extensions: readonly Extension[]): void {
	runnerExtensions.set(runner, extensions);
}

/** `reclaimExtensionHandles` for the extension instances of `runner`; a runner never registered has none. */
export function reclaimRunnerHandles(runner: object): void {
	reclaimExtensionHandles(runnerExtensions.get(runner) ?? []);
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Closes what each extension instance left open after its `session_shutdown`
 * handlers ran, and reports it per extension on stderr so the extension can be fixed.
 */
export function reclaimExtensionHandles(extensions: readonly Extension[]): void {
	for (const extension of extensions) {
		const ledger = ledgers.get(extension);
		if (ledger === undefined) continue;
		// Bundled extensions and generated shims load as "local" and are relabelled builtin after their factory ran.
		if (extension.sourceInfo.source === "builtin") {
			ledgers.delete(extension);
			continue;
		}
		const { counts, failures } = ledger.reclaim();
		const total = counts.server + counts.socket + counts.timer;
		if (total === 0 && failures.length === 0) continue;
		const closed = [
			plural(counts.server, "server"),
			plural(counts.socket, "socket"),
			plural(counts.timer, "timer"),
		].join(", ");
		const failed = failures.length > 0 ? `; could not close ${failures.join("; ")}` : "";
		console.warn(
			`Extension ${extension.path} left handles open after session_shutdown; senpi closed ${closed}${failed}. Stop session-scoped resources in a session_shutdown handler (docs/extensions.md#session_shutdown).`,
		);
	}
}
