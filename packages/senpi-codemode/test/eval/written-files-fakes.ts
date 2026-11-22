import { basename, dirname, join, relative, sep } from "node:path";
import type { ExtensionToolContext } from "@code-yeongyu/senpi";
import type { FileSignature, FsAccess, GitOutcome, RunGit } from "../../src/written-files/scan-boundaries.ts";
import { WrittenFiles } from "../../src/written-files/written-files.ts";
import { fakeExtensionContext } from "./fakes.ts";

type ReportToolResult = ExtensionToolContext["reportToolResult"];
export type ReportedResult = Parameters<ReportToolResult>[0];

/**
 * An in-memory repository behind the two boundaries the written-files check reads through: every write advances a
 * virtual clock, so signatures differ without real time, and `git status` lists what differs from the last commit.
 * Directories can be symlinks, which the filesystem follows in every entry but the last, as the operating system does.
 * A file can be a symlink too, and an open follows it: this filesystem stands for a platform that cannot open without
 * following the last entry. With `caseInsensitive` set, two spellings that differ only in case name the same entry.
 */
export class FakeWorkspace {
	readonly cwd = sep === "/" ? "/work" : "C:\\work";
	readonly gitCalls: string[][] = [];
	/** Every path the filesystem read bytes from, as it resolved it. */
	readonly reads: string[] = [];
	/** When set, `git status` answers with it instead of the repository's state. */
	statusOutcome: GitOutcome | undefined;
	/** Runs as a read starts, after the file was checked and before it is opened. */
	beforeOpen: ((path: string) => void) | undefined;
	/** Awaited once a read has its bytes, before it returns them: a test holds a read open with it. */
	afterRead: ((path: string, limit: number) => Promise<void>) | undefined;
	/** Set before the first write: whether the filesystem folds case, as macOS and Windows ones do by default. */
	caseInsensitive = false;
	/** Absolute paths whose identity lookup fails without telling whether anything is there (EACCES, EIO, ELOOP). */
	readonly identityFailures = new Set<string>();
	/** Keyed by the file's absolute real path. */
	readonly #files = new Map<string, { readonly bytes: Uint8Array; readonly signature: FileSignature }>();
	/** A symlinked directory's absolute path and the absolute directory it points to. */
	readonly #links = new Map<string, string>();
	/** A symlinked file's absolute path and the absolute file it points to. */
	readonly #fileLinks = new Map<string, string>();
	readonly #ignored = new Set<string>();
	readonly #committed = new Map<string, string>();
	/** Committed paths `git rm --cached` took out of the index. */
	readonly #removedFromIndex = new Set<string>();
	/** Paths `git add` put in the index that the last commit does not have. */
	readonly #staged = new Set<string>();
	readonly #directoryInodes = new Map<string, number>();
	#clock = 0;

	write(path: string, content: string | Uint8Array): void {
		this.writeAt(this.absolute(path), content);
	}

	/** Writes a file at an absolute path, which may lie outside the workspace. */
	writeAt(absolutePath: string, content: string | Uint8Array): void {
		const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
		this.#clock += 1;
		const signature = { size: bytes.length, mtimeMs: this.#clock, ctimeMs: this.#clock, dev: 1, ino: this.#clock };
		this.#files.set(this.#key(this.#resolve(absolutePath)), { bytes, signature });
	}

	remove(path: string): void {
		this.#files.delete(this.#key(this.absolute(path)));
	}

	/** Moves the workspace file `path` to the absolute `target` on the same filesystem: same device and inode. */
	moveOut(path: string, target: string): void {
		const file = this.#files.get(this.#key(this.absolute(path)));
		if (file === undefined) return;
		this.#files.delete(this.#key(this.absolute(path)));
		this.#files.set(this.#key(target), file);
	}

	/**
	 * `git rm --cached`: the file `path` leaves the index and stays on disk, untracked. A committed file leaves a
	 * deletion record in `git status`; a file only staged since the last commit leaves none.
	 */
	untrack(path: string): void {
		if (!this.#staged.delete(path)) this.#removedFromIndex.add(path);
	}

	/** `git add` of a file the last commit does not have. */
	stage(path: string): void {
		this.#staged.add(path);
	}

	/** Replaces the workspace directory `path` and everything in it with a symlink to the absolute `target`. */
	link(path: string, target: string): void {
		const directory = this.absolute(path);
		for (const file of [...this.#files.keys()])
			if (file.startsWith(this.#key(directory) + sep)) this.#files.delete(file);
		this.#links.set(directory, target);
	}

	/** Replaces the workspace file `path` with a symlink to the absolute file `target`. */
	linkFile(path: string, target: string): void {
		this.#files.delete(this.#key(this.absolute(path)));
		this.#fileLinks.set(this.#key(this.absolute(path)), target);
	}

	/** Adds an ignore rule for the untracked workspace file `path`. */
	ignore(path: string): void {
		this.#ignored.add(path);
	}

	commit(): void {
		this.#committed.clear();
		this.#staged.clear();
		for (const [path, file] of this.#workspaceFiles())
			this.#committed.set(path, new TextDecoder().decode(file.bytes));
	}

	absolute(path: string): string {
		return [this.cwd, ...path.split("/")].join(sep);
	}

	readonly fs: FsAccess = {
		realpath: async (path) => {
			const named = this.#followParents(path);
			const target = this.#fileLinks.get(this.#key(named));
			return target === undefined ? this.#resolve(path) : this.#resolve(target);
		},
		lstat: async (path) => this.#files.get(this.#key(this.#followParents(path)))?.signature,
		identity: async (path) => {
			if (this.identityFailures.has(path)) return { kind: "unknown" };
			const key = this.#key(this.#resolve(path));
			const file = this.#files.get(key);
			if (file !== undefined) return { kind: "found", dev: file.signature.dev, ino: file.signature.ino };
			if (![...this.#files.keys()].some((stored) => stored.startsWith(key + sep))) return { kind: "absent" };
			const ino = this.#directoryInodes.get(key) ?? 1_000_000 + this.#directoryInodes.size;
			this.#directoryInodes.set(key, ino);
			return { kind: "found", dev: 1, ino };
		},
		read: async (path, limit, accept) => {
			this.beforeOpen?.(path);
			const named = this.#key(this.#followParents(path));
			const link = this.#fileLinks.get(named);
			const opened = link === undefined ? named : this.#key(link);
			const file = this.#files.get(opened);
			if (file === undefined || !(await accept(file.signature))) return undefined;
			this.reads.push(opened);
			const bytes = file.bytes.subarray(0, limit);
			await this.afterRead?.(path, limit);
			return bytes;
		},
	};

	/** How the filesystem tells entries apart: by the path as spelled, or with case folded. */
	#key(path: string): string {
		return this.caseInsensitive ? path.toLowerCase() : path;
	}

	/** The path with every symlinked directory in it replaced by its target. */
	#resolve(path: string): string {
		let resolved = path;
		for (let hop = 0; hop < 40; hop++) {
			const link = [...this.#links].find(([from]) => resolved === from || resolved.startsWith(from + sep));
			if (link === undefined) return resolved;
			resolved = link[1] + resolved.slice(link[0].length);
		}
		return resolved;
	}

	/** What lstat and an open of `path` reach: parents resolved, the last entry taken as named. */
	#followParents(path: string): string {
		return join(this.#resolve(dirname(path)), basename(path));
	}

	/** Workspace-relative POSIX paths of the regular files git sees: none below a symlinked directory. */
	#workspaceFiles(): Array<[string, { readonly bytes: Uint8Array }]> {
		return [...this.#files].flatMap(([path, file]) => {
			const inside = relative(this.cwd, path);
			return outside(inside) || this.#resolve(path) !== path ? [] : [[inside.split(sep).join("/"), file]];
		});
	}

	readonly git: RunGit = async (args) => {
		this.gitCalls.push([...args]);
		if (args[0] === "rev-parse") return { kind: "ok", stdout: `${this.cwd}\n\n` };
		if (args[0] === "--literal-pathspecs" && args[1] === "ls-files") {
			const named = args.slice(args.indexOf("--") + 1);
			const indexed = named.filter(
				(path) => this.#staged.has(path) || (this.#committed.has(path) && !this.#removedFromIndex.has(path)),
			);
			return { kind: "ok", stdout: indexed.map((path) => `${path}\0`).join("") };
		}
		if (args[0] !== "status") return { kind: "exit", code: 1 };
		if (this.statusOutcome !== undefined) return this.statusOutcome;
		const records = ["# branch.oid 1111111111111111111111111111111111111111", "# branch.head main"];
		const present = new Map(this.#workspaceFiles());
		for (const [path, file] of present) {
			const committed = this.#committed.get(path);
			if (committed !== undefined && this.#removedFromIndex.has(path)) {
				records.push(`1 D. N... 100644 000000 000000 aaaa 0000 ${path}`);
				if (!this.#ignored.has(path)) records.push(`? ${path}`);
			} else if (committed === undefined && this.#staged.has(path)) {
				records.push(`1 A. N... 000000 100644 100644 0000 aaaa ${path}`);
			} else if (committed === undefined) {
				if (!this.#ignored.has(path)) records.push(`? ${path}`);
			} else if (committed !== new TextDecoder().decode(file.bytes))
				records.push(`1 .M N... 100644 100644 100644 aaaa bbbb ${path}`);
		}
		for (const path of this.#committed.keys())
			if (!present.has(path)) records.push(`1 .D N... 100644 100644 000000 aaaa bbbb ${path}`);
		for (const link of this.#links.keys()) {
			const inside = relative(this.cwd, link);
			if (!outside(inside)) records.push(`? ${inside.split(sep).join("/")}`);
		}
		return { kind: "ok", stdout: `${records.join("\0")}\0` };
	};
}

/** Git's view: only the parent segment and what lies below it leave the work tree, so `..draft.ts` is inside. */
function outside(inside: string): boolean {
	return inside === ".." || inside.startsWith(`..${sep}`);
}

export interface WrittenFilesHarness {
	readonly workspace: FakeWorkspace;
	readonly writtenFiles: WrittenFiles;
	/** Every result the cell reported to the host's `tool_result` handlers, in order. */
	readonly reported: ReportedResult[];
	readonly ctx: ExtensionToolContext;
}

/** `hooks` stands for the session's `tool_result` handlers; by default they change nothing. */
export function writtenFilesHarness(
	hooks?: ReportToolResult,
	options: { readonly hooksRunHere?: () => boolean } = {},
): WrittenFilesHarness {
	const workspace = new FakeWorkspace();
	const reported: ReportedResult[] = [];
	const ctx: ExtensionToolContext = {
		...fakeExtensionContext(),
		cwd: workspace.cwd,
		reportToolResult: async (report) => {
			reported.push(report);
			return hooks === undefined
				? { toolCallId: `cell/reported-${reported.length}`, result: undefined, failures: [] }
				: await hooks(report);
		},
	};
	const writtenFiles = new WrittenFiles({
		cwd: workspace.cwd,
		artifactsDir: workspace.absolute("artifacts"),
		git: workspace.git,
		fs: workspace.fs,
		...options,
	});
	return { workspace, writtenFiles, reported, ctx };
}

/** Runs `work` as one cell's writes and returns what the cell would list. */
export async function cellListing(
	harness: WrittenFilesHarness,
	work: () => void,
): Promise<readonly string[] | undefined> {
	const cell = harness.writtenFiles.open(harness.ctx);
	await cell.ready;
	work();
	const outcome = await cell.settle(new AbortController().signal);
	cell.close();
	return outcome?.kind === "written" ? outcome.report.files : undefined;
}

export function reportedPaths(harness: WrittenFilesHarness): unknown[] {
	return harness.reported.map((report) => report.input.path);
}
