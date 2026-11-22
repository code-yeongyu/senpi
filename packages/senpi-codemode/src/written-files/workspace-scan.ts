import { isAbsolute, join, relative, sep } from "node:path";
import type { FileSignature, GitOutcome, RunGit } from "./scan-boundaries.ts";
import type { ScanFs } from "./workspace-fs.ts";
import { excludedDirectories, isSourcePath, SOURCE_FILE_MAX_BYTES } from "./source-file.ts";

/** One git process of a scan is killed at this deadline. */
const SCAN_TIMEOUT_MS = 500;
/** A scan that would stat more changed or untracked paths than this is abandoned. */
const SCAN_PATH_LIMIT = 5_000;

const STAT_BATCH = 64;
const INITIAL_HEAD = "(initial)";
/** What `git diff` compares with when the first commit was made between two scans. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const HEAD_RECORD = "# branch.oid ";

export type ScanSkipReason = "git_unavailable" | "over_budget" | "scan_failed";

/**
 * The workspace's source-file candidates and their signatures: in a repository the files that differ from HEAD or are
 * untracked, elsewhere every file its ignore rules leave. A candidate missing from an earlier scan was clean or absent
 * then, so two scans compare without a walk of the unchanged tree.
 */
export interface ScannedFiles {
	readonly files: ReadonlyMap<string, FileSignature>;
	readonly head: string | undefined;
	/** The paths of `files` git tracks. */
	readonly tracked: ReadonlySet<string>;
}

export type WorkspaceScan =
	| ({ readonly kind: "files" } & ScannedFiles)
	| { readonly kind: "skipped"; readonly reason: ScanSkipReason };

type ScanMode = { readonly kind: "repository"; readonly prefix: string } | { readonly kind: "plain" };

export interface WorkspaceScannerOptions {
	readonly cwd: string;
	/** The session's artifacts directory; files below it are the session's own, never a cell's source files. */
	readonly artifactsDir: string;
	readonly git: RunGit;
	readonly fs: ScanFs;
	readonly timeoutMs?: number;
	readonly pathLimit?: number;
}

export class WorkspaceScanner {
	readonly #cwd: string;
	readonly #scratchDir: string;
	readonly #artifactsPrefix: string | undefined;
	readonly #runGit: RunGit;
	readonly #fs: ScanFs;
	readonly #timeoutMs: number;
	readonly #pathLimit: number;
	#mode: ScanMode | undefined;
	#scratchReady = false;

	constructor(options: WorkspaceScannerOptions) {
		this.#cwd = options.cwd;
		// The empty repository that lists a workspace without one under its own ignore files.
		this.#scratchDir = join(options.artifactsDir, "written-files-scan");
		const inside = relative(options.cwd, options.artifactsDir);
		this.#artifactsPrefix =
			inside === "" || inside.startsWith("..") || isAbsolute(inside) ? undefined : `${inside.split(sep).join("/")}/`;
		this.#runGit = options.git;
		this.#fs = options.fs;
		this.#timeoutMs = options.timeoutMs ?? SCAN_TIMEOUT_MS;
		this.#pathLimit = options.pathLimit ?? SCAN_PATH_LIMIT;
	}

	/**
	 * In a repository the tracked candidates of `previous` stay candidates: a file written back to its HEAD content
	 * leaves `git status`, and so do files committed since `previous`.
	 */
	async scan(previous?: ScannedFiles): Promise<WorkspaceScan> {
		const mode = this.#mode ?? (await this.#detectMode());
		if (typeof mode === "string") return { kind: "skipped", reason: mode };
		this.#mode = mode;
		return mode.kind === "repository" ? this.#scanRepository(mode.prefix, previous) : this.#scanPlain();
	}

	async #detectMode(): Promise<ScanMode | ScanSkipReason> {
		const located = await this.#git(["rev-parse", "--show-toplevel", "--show-prefix"]);
		if (located.kind === "unavailable" || located.kind === "over_budget") return skipReason(located);
		if (located.kind === "exit") return { kind: "plain" };
		const prefix = located.stdout.split("\n")[1] ?? "";
		if (prefix === "") return { kind: "repository", prefix };
		// A workspace the enclosing repository ignores has no rules there: its own ignore files decide.
		const ignored = await this.#git(["check-ignore", "--quiet", "."]);
		if (ignored.kind === "over_budget") return "over_budget";
		return ignored.kind === "ok" ? { kind: "plain" } : { kind: "repository", prefix };
	}

	async #scanRepository(prefix: string, previous: ScannedFiles | undefined): Promise<WorkspaceScan> {
		const status = await this.#git([
			"status",
			"--porcelain=v2",
			"--branch",
			"-z",
			"--untracked-files=all",
			"--no-renames",
			"--ignore-submodules=all",
			"--",
			".",
		]);
		if (status.kind !== "ok") return { kind: "skipped", reason: skipReason(status) };
		const { head, untracked, tracked, untrackedFromIndex } = parseStatus(status.stdout);
		const committed: string[] = [];
		const previousHead = previous?.head;
		if (previousHead !== undefined && head !== undefined && head !== previousHead && head !== INITIAL_HEAD) {
			const since = previousHead === INITIAL_HEAD ? EMPTY_TREE : previousHead;
			const diff = await this.#git(["diff", "--name-status", "-z", "--no-renames", since, head, "--", "."]);
			if (diff.kind === "over_budget") return { kind: "skipped", reason: "over_budget" };
			if (diff.kind === "ok") {
				const { added, deleted } = parseNameStatus(diff.stdout);
				committed.push(...added);
				untrackedFromIndex.push(...deleted);
			}
		}
		// Porcelain paths are relative to the repository root, the workspace may be a directory below it.
		const inWorkspace = (paths: readonly string[]) =>
			paths.flatMap((path) => (path.startsWith(prefix) ? [path.slice(prefix.length)] : []));
		// Only tracked files are carried over: an untracked one leaves `git status` when it is deleted, committed (the
		// diff above finds it) or ignored, and an ignored file is no candidate. A path deleted from the index, staged or
		// committed, is untracked from then on, so neither its deletion nor an earlier scan carries it; a status record
		// other than a deletion is the index as it is now and outranks both. A path that left `git status` without a
		// record (`git rm --cached` of a file HEAD does not have leaves none) is carried only once the index shows it.
		const gone = new Set(inWorkspace(untrackedFromIndex));
		const listed = new Set(inWorkspace(tracked));
		const unlisted = [...new Set([...inWorkspace(committed), ...(previous?.tracked ?? [])])].filter(
			(path) => !gone.has(path) && !listed.has(path),
		);
		const indexed = await this.#indexed(unlisted);
		if (indexed === "over_budget") return { kind: "skipped", reason: "over_budget" };
		const trackedHere = [...listed, ...unlisted.filter((path) => indexed.has(path))];
		return this.#signatures([...inWorkspace(untracked), ...trackedHere], head, new Set(trackedHere));
	}

	/** Which of the workspace-relative `paths` the index has, in one git process; none when git cannot say. */
	async #indexed(paths: readonly string[]): Promise<ReadonlySet<string> | "over_budget"> {
		if (paths.length === 0) return new Set();
		if (paths.length > this.#pathLimit) return "over_budget";
		const listed = await this.#git(["--literal-pathspecs", "ls-files", "-z", "--cached", "--", ...paths]);
		if (listed.kind === "over_budget") return "over_budget";
		return new Set(listed.kind === "ok" ? listed.stdout.split("\0").filter((path) => path !== "") : []);
	}

	async #scanPlain(): Promise<WorkspaceScan> {
		if (!this.#scratchReady) {
			const created = await this.#git(["init", "--quiet", this.#scratchDir]);
			if (created.kind !== "ok") return { kind: "skipped", reason: skipReason(created) };
			this.#scratchReady = true;
		}
		const listed = await this.#git([
			`--git-dir=${join(this.#scratchDir, ".git")}`,
			`--work-tree=${this.#cwd}`,
			"ls-files",
			"-z",
			"--others",
			"--exclude-standard",
			// Without a repository nothing ignores these, and listing them is what makes a fresh project slow.
			...excludedDirectories().map((directory) => `--exclude=${directory}/`),
		]);
		if (listed.kind !== "ok") return { kind: "skipped", reason: skipReason(listed) };
		return this.#signatures(listed.stdout.split("\0"), undefined, new Set());
	}

	async #signatures(
		paths: readonly string[],
		head: string | undefined,
		tracked: ReadonlySet<string>,
	): Promise<WorkspaceScan> {
		const artifacts = this.#artifactsPrefix;
		const candidates = [...new Set(paths)].filter(
			(path) => isSourcePath(path) && (artifacts === undefined || !path.startsWith(artifacts)),
		);
		if (candidates.length > this.#pathLimit) return { kind: "skipped", reason: "over_budget" };
		const files = new Map<string, FileSignature>();
		for (let start = 0; start < candidates.length; start += STAT_BATCH) {
			const batch = candidates.slice(start, start + STAT_BATCH);
			const signatures = await Promise.all(batch.map((path) => this.#fs.stat(join(this.#cwd, path))));
			batch.forEach((path, index) => {
				const signature = signatures[index];
				if (signature !== undefined && signature.size <= SOURCE_FILE_MAX_BYTES) files.set(path, signature);
			});
		}
		return { kind: "files", files, head, tracked: new Set([...tracked].filter((path) => files.has(path))) };
	}

	#git(args: readonly string[]): Promise<GitOutcome> {
		return this.#runGit(args, { cwd: this.#cwd, timeoutMs: this.#timeoutMs });
	}
}

function skipReason(outcome: Exclude<GitOutcome, { kind: "ok" }>): ScanSkipReason {
	if (outcome.kind === "unavailable") return "git_unavailable";
	return outcome.kind === "over_budget" ? "over_budget" : "scan_failed";
}

interface StatusRecords {
	head: string | undefined;
	untracked: string[];
	tracked: string[];
	/** Deleted from the index (`git rm --cached`): the file may still be on disk, but git no longer tracks it. */
	untrackedFromIndex: string[];
}

/** Reads `git status --porcelain=v2 --branch -z`: one NUL-terminated record per header and per path. */
function parseStatus(stdout: string): StatusRecords {
	let head: string | undefined;
	const untracked: string[] = [];
	const tracked: string[] = [];
	const untrackedFromIndex: string[] = [];
	const records = stdout.split("\0");
	for (let index = 0; index < records.length; index++) {
		const record = records[index] ?? "";
		if (record.startsWith(HEAD_RECORD)) head = record.slice(HEAD_RECORD.length);
		else if (record.startsWith("? ")) untracked.push(record.slice(2));
		// The first letter of the `XY` field is the index side: `D` there means the index no longer has the path.
		else if (record.startsWith("1 D")) untrackedFromIndex.push(pathAfterFields(record, 8));
		else if (record.startsWith("1 ")) tracked.push(pathAfterFields(record, 8));
		else if (record.startsWith("u ")) tracked.push(pathAfterFields(record, 10));
		else if (record.startsWith("2 ")) {
			tracked.push(pathAfterFields(record, 9));
			// A rename's source path follows as its own record.
			index += 1;
		}
	}
	return { head, untracked, tracked, untrackedFromIndex };
}

/** Reads `git diff --name-status -z --no-renames`: a status letter, then the path, each NUL-terminated. */
function parseNameStatus(stdout: string): { added: string[]; deleted: string[] } {
	const added: string[] = [];
	const deleted: string[] = [];
	const fields = stdout.split("\0");
	for (let index = 0; index + 1 < fields.length; index += 2) {
		const path = fields[index + 1] ?? "";
		if (fields[index] === "D") deleted.push(path);
		else added.push(path);
	}
	return { added, deleted };
}

function pathAfterFields(record: string, fields: number): string {
	let offset = 0;
	for (let field = 0; field < fields; field++) {
		const space = record.indexOf(" ", offset);
		if (space === -1) return "";
		offset = space + 1;
	}
	return record.slice(offset);
}
