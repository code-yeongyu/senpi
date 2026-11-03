import type { FilesystemPolicyChecker } from "./policy/filesystem.ts";

/** Every operation name a `PolicyHooks.beforeOp` gate can see. */
export type OpName =
	| "files.read"
	| "files.write"
	| "files.edit"
	| "files.glob"
	| "files.grep"
	| "files.stat"
	| "files.list"
	| "process.exec"
	| "process.spawn"
	| "process.write"
	| "process.kill"
	| "process.sweep"
	| "info.message";

export type PolicyDecision = { readonly allow: true } | { readonly allow: false; readonly reason: string };

export type OpOutcome =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly error: unknown };

export interface PolicyHooks {
	/** Deny-wins path checker (the filesystem policy composed from registered policies). */
	readonly filesystem?: FilesystemPolicyChecker;
	/** The one gate both paths call before any effect: may `ctx.principal` run `op` with `args` under `ctx.scope`? */
	readonly beforeOp?: (op: OpName, args: unknown, ctx: OpContext) => Promise<PolicyDecision>;
	readonly afterOp?: (op: OpName, args: unknown, outcome: OpOutcome, ctx: OpContext) => Promise<void>;
}

export interface Limits {
	/** Largest file `files.read`/`files.edit`/`files.grep` reads; 10 MiB on the machine path. */
	readonly readMaxBytes: number;
	/** Captured stdout of one `process.exec`; 8 MiB on the machine path. Streaming via `onOutput` is never capped. */
	readonly execStdoutMaxBytes: number;
	/** Captured stderr of one `process.exec`; 1 MiB on the machine path. */
	readonly execStderrMaxBytes: number;
	/** Timeout when an exec request names none. */
	readonly execTimeoutDefaultMs: number;
	/** Screen history kept per PTY handle. */
	readonly ptyScrollbackBytes: number;
	/** Raw output tail kept per PTY handle. */
	readonly retainedOutputBytes: number;
	/** Live PTY handles allowed at once; undefined = no cap. */
	readonly maxPtySessions?: number;
}

export interface AuditEntry {
	readonly op: OpName;
	readonly principal: OpContext["principal"];
	readonly target: string;
	readonly verdict: "allowed" | "denied";
}

export interface OpContext {
	/**
	 * The scope the operation runs in. `root`, when set, contains every path the operation touches (a path or symlink
	 * resolving outside it is a policy denial); absent means no containment beyond `policy.filesystem`.
	 */
	readonly scope: { readonly id: string; readonly root?: string };
	readonly principal: { readonly kind: "local-session" | "remote-device"; readonly id: string };
	readonly signal: AbortSignal;
	readonly limits: Limits;
	readonly policy: PolicyHooks;
	readonly audit?: (entry: AuditEntry) => void;
	/**
	 * Set by a caller that already holds the per-path mutation slot of every path this operation mutates (the tool
	 * path takes it around its whole read-modify-write). Absent means a mutating operation takes the slot itself.
	 */
	readonly pathLock?: "caller";
}

export type OpErrorCode =
	| "policy_denied"
	| "not_found"
	| "limit_exceeded"
	| "invalid_pattern"
	| "invalid_argument"
	| "permission_denied"
	| "aborted"
	| "io_error";

export interface ReadRequest {
	readonly path: string;
	readonly offset?: number;
	readonly limitBytes?: number;
}
export interface ReadResult {
	readonly path: string;
	readonly bytes: Uint8Array;
	/** Size of the whole file. */
	readonly size: number;
	readonly offset: number;
}

export interface WriteRequest {
	readonly path: string;
	readonly bytes: Uint8Array;
	readonly createParentDirs?: boolean;
	/** Write `bytes` at this byte offset of an existing or new file instead of replacing the file. */
	readonly offset?: number;
	/** With `offset`: the final file size, so ranges written in any order leave the same file. */
	readonly total?: number;
}
export interface WriteResult {
	readonly path: string;
	readonly writtenBytes: number;
}

export interface EditRequest {
	readonly path: string;
	readonly exact: string;
	readonly replacement: string;
}
export interface EditResult {
	readonly path: string;
	readonly content: string;
	readonly replacements: number;
	readonly writeResult: WriteResult;
}

export type EntryType = "file" | "directory" | "symlink" | "other";

export interface GlobRequest {
	readonly pattern: string;
	readonly cwd?: string;
	readonly limit?: number;
}
export interface GlobResult {
	/** Matching paths as the search printed them (absolute under `cwd`). */
	readonly entries: readonly { readonly path: string }[];
	readonly truncated: boolean;
}

export interface GrepRequest {
	readonly path: string;
	readonly pattern: string;
	readonly limit?: number;
}
export interface GrepMatch {
	readonly path: string;
	readonly line: number;
	readonly text: string;
}
export interface GrepResult {
	readonly matches: readonly GrepMatch[];
	readonly truncated: boolean;
}

export interface StatRequest {
	readonly path: string;
	/** Also require these permissions (fs.access); the access error is the operation's error. */
	readonly access?: "read" | "write" | "readwrite";
}
export interface StatResult {
	readonly path: string;
	readonly type: EntryType;
	readonly size: number;
	readonly mtimeMs: number;
	readonly mode: number;
}

export interface ListRequest {
	readonly path: string;
}
export interface ListResult {
	readonly path: string;
	/** Directory entries in the order the filesystem returned them. */
	readonly entries: readonly { readonly name: string; readonly type: EntryType }[];
}

export interface FileOps {
	read(req: ReadRequest, ctx: OpContext): Promise<ReadResult>;
	write(req: WriteRequest, ctx: OpContext): Promise<WriteResult>;
	edit(req: EditRequest, ctx: OpContext): Promise<EditResult>;
	glob(req: GlobRequest, ctx: OpContext): Promise<GlobResult>;
	grep(req: GrepRequest, ctx: OpContext): Promise<GrepResult>;
	stat(req: StatRequest, ctx: OpContext): Promise<StatResult>;
	list(req: ListRequest, ctx: OpContext): Promise<ListResult>;
}

export interface ExecShell {
	readonly path: string;
	readonly args: readonly string[];
	/** "stdin" pipes the command to the shell's stdin; "argv" appends it as the last argument. Default "argv". */
	readonly commandTransport?: "argv" | "stdin";
}

export interface ExecRequest {
	readonly command: string;
	readonly cwd?: string;
	/** Environment entries; with `envMode: "overlay"` (default) laid over a curated base, with "exact" used as-is. */
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly envMode?: "overlay" | "exact";
	/** Default: `/bin/sh -c` (POSIX), `cmd.exe /d /s /c` (Windows). */
	readonly shell?: ExecShell;
	/** Default `ctx.limits.execTimeoutDefaultMs`; `Infinity` disables the timeout. */
	readonly timeoutMs?: number;
	/** Every output chunk as it arrives, uncapped. */
	readonly onOutput?: (chunk: Buffer, stream: "stdout" | "stderr") => void;
	readonly onSpawn?: (pid: number) => void;
	/** Called once the shell process itself exits (possibly after `exec` settled on an abort). */
	readonly onExit?: (pid: number) => void;
}

export interface ExecResult {
	readonly pid: number | undefined;
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly stdout: Uint8Array;
	readonly stderr: Uint8Array;
	readonly stdoutTruncated: boolean;
	readonly stderrTruncated: boolean;
	readonly timedOut: boolean;
	readonly aborted: boolean;
	readonly startedAtMs: number;
	readonly durationMs: number;
	readonly scopeToken: string;
}

export interface SpawnRequest {
	readonly command: string;
	readonly args?: readonly string[];
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly cols?: number;
	readonly rows?: number;
}

export type HandleLifecycle = "running" | "exited" | "killed";

export interface HandleStatus {
	readonly id: string;
	readonly pid: number;
	readonly state: HandleLifecycle;
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly lastSeq: number;
	readonly retainedBytes: number;
	readonly omittedBytes: number;
	readonly startedAtMs: number;
}

export interface OutputChunk {
	readonly seq: number;
	readonly bytes: Uint8Array;
}

export interface StdinEffect {
	readonly acceptedBytes: number;
	/** With `expectActivityMs`: whether output followed the write within that window. */
	readonly observed?: boolean;
}

export interface WaitSpec {
	/** Resolve when the output produced after the wait started contains this text. */
	readonly output?: string;
	readonly timeoutMs: number;
}

export interface WaitResult {
	readonly status: HandleStatus;
	readonly reason: "exited" | "matched" | "timeout";
}

export interface ProcessHandle {
	readonly id: string;
	readonly pid: number;
	readonly scopeToken: string;
	status(): HandleStatus;
	output(fromSeq: number): AsyncIterable<OutputChunk>;
	screen(opts?: { history?: number }): Promise<string>;
	write(bytes: Uint8Array, opts?: { expectActivityMs?: number }): Promise<StdinEffect>;
	wait(spec: WaitSpec): Promise<WaitResult>;
	resize(cols: number, rows: number): void;
	/** A named signal is sent once; no signal runs the HUP/TERM/KILL ladder over the handle's scope. */
	kill(signal?: NodeJS.Signals): Promise<void>;
}

export interface HandleInfo {
	readonly id: string;
	readonly pid: number;
	readonly principal: string;
	readonly scopeToken: string;
	readonly command: string;
	readonly state: HandleLifecycle;
}

export interface ProcessOps {
	exec(req: ExecRequest, ctx: OpContext): Promise<ExecResult>;
	spawn(req: SpawnRequest, ctx: OpContext): Promise<ProcessHandle>;
	handle(id: string): ProcessHandle | undefined;
	list(principal?: string): readonly HandleInfo[];
	sweep(tokens: readonly string[]): Promise<void>;
}

export interface ProcessInfo {
	readonly pid: number;
	readonly startedAtMs: number;
	readonly cpuTimeMs: number;
	readonly rssBytes: number;
	readonly command: string;
	readonly lastOpAtMs?: number;
}

export interface HostFacts {
	readonly os: NodeJS.Platform;
	readonly arch: string;
	readonly load1: number;
	readonly cores: number;
	readonly runtime: string;
}

export interface MessageResult {
	readonly accepted: true;
	readonly seq: number;
	readonly inboxPath: string;
}

export interface InfoOps {
	processInfo(req?: { pid?: number; handleId?: string }): Promise<ProcessInfo>;
	host(): HostFacts;
	message(req: { topic: string; body: unknown }, ctx: OpContext): Promise<MessageResult>;
}

export interface MachineOps {
	readonly files: FileOps;
	readonly process: ProcessOps;
	readonly info: InfoOps;
	/** The host defaults this instance was created with; callers build `OpContext.limits` from them. */
	readonly limits: Limits;
}
