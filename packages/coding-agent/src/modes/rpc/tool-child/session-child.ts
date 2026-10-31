/**
 * One session's tool child (senpi#3566, plan todo 4). The child starts on the first job routed to it, never earlier;
 * a dead child is started again (a new generation) by the next job. Status is the minimal row todo 14 extends:
 * `session_tool_child{state: "spawned" | "exited" | "respawned", generation, pid}` records and the `list_sessions`
 * row `tool_child: {state: "none" | "live" | "exited", generation?, pid?}`.
 */
import { dirname, isAbsolute, resolve } from "node:path";
import type { RegisteredTool } from "../../../core/extensions/types.ts";
import type {
	ToolChildKindRunner,
	ToolChildModuleJob,
	ToolChildRunner,
	ToolChildRunResult,
} from "../../../core/tool-dispatch/tool-dispatcher.ts";
import { ToolChildClient, ToolChildError, type ToolChildStatus, type ToolChildWake } from "./client.ts";
import type { HostCallHandler } from "./host-calls-server.ts";
import { CrashLoop, fixtureDeadline } from "./job-policy.ts";
import type { ToolChildCommand } from "./launch.ts";
import { MODULE_JOB_KIND, TOOL_CHILD_MODULE_ROOTS_ENV } from "./module-job.ts";

export interface SessionToolChildRecord {
	readonly state: "spawned" | "exited" | "respawned";
	readonly generation: number;
	readonly pid: number;
}

export interface SessionToolChildRow {
	readonly state: "none" | "live" | "exited";
	readonly generation?: number;
	readonly pid?: number;
}

export interface SessionToolChildOptions {
	readonly dir: string;
	readonly cwd: string;
	/** Installed extension directories the child may load `module` jobs from, read at every spawn. */
	readonly moduleRoots: () => readonly string[];
	readonly onRecord: (record: SessionToolChildRecord) => void;
	readonly env?: NodeJS.ProcessEnv;
	readonly command?: ToolChildCommand;
	/** Serves the child's reverse-bridge calls; the request's `context.toolCallId` names the calling tool call. */
	readonly onHostCall?: HostCallHandler;
	/** Receives the child's wakes (`ToolChildWake`); the session hands each to the job definition of its kind. */
	readonly onWake?: (wake: ToolChildWake) => void;
	/** The crash loop's clock; tests inject a fake one. */
	readonly now?: () => number;
}

/** The directories of the extensions whose tools declare a `childModule`: the only places a `module` job may load from. */
export function toolChildModuleRoots(tools: readonly RegisteredTool[]): readonly string[] {
	// Exactly the files tools declared, never their directory: a single-file extension in a broad directory (a project
	// root, `extensions/`) would otherwise grant every module beside it.
	return [
		...new Set(
			tools.flatMap((tool) => {
				const childModule = tool.definition.childModule;
				if (childModule === undefined || tool.sourceInfo.path.startsWith("<")) return [];
				return [
					isAbsolute(childModule.path)
						? childModule.path
						: resolve(dirname(tool.sourceInfo.path), childModule.path),
				];
			}),
		),
	];
}

export class SessionToolChild {
	readonly #options: SessionToolChildOptions;
	readonly #client: ToolChildClient;
	#starting: Promise<void> | undefined;
	#last: { readonly generation: number; readonly pid: number } | undefined;
	#closed = false;
	readonly #crashLoop: CrashLoop;

	constructor(options: SessionToolChildOptions) {
		this.#options = options;
		this.#crashLoop = new CrashLoop(options.now ?? Date.now);
		this.#client = new ToolChildClient({
			dir: options.dir,
			cwd: options.cwd,
			env: () => ({
				...(options.env ?? process.env),
				[TOOL_CHILD_MODULE_ROOTS_ENV]: JSON.stringify(options.moduleRoots()),
			}),
			...(options.command === undefined ? {} : { command: options.command }),
			onStatus: (status) => this.#onStatus(status),
			...(options.onHostCall === undefined ? {} : { onHostCall: options.onHostCall }),
			...(options.onWake === undefined ? {} : { onWake: options.onWake }),
		});
	}

	/**
	 * Runs a module job on this session's child. A job lost to the child's exit is retried exactly once, on a fresh
	 * generation, and only when it is idempotent; a non-idempotent job reports the error and is never re-run.
	 */
	readonly runner: ToolChildRunner = async (job: ToolChildModuleJob, signal: AbortSignal | undefined) => {
		try {
			return await this.#runOnce(job, signal);
		} catch (error) {
			const lostToExit = error instanceof ToolChildError && error.code === "tool_child_exited";
			if (!lostToExit || job.idempotent !== true || signal?.aborted === true) throw error;
			return this.#runOnce(job, signal);
		}
	};

	/**
	 * Runs a job of a built-in kind (`ToolDefinition.childJob`, e.g. `terminal.bash`) on this session's child, streaming
	 * its updates to `onUpdate`. Never retried: such a job's state (a PTY session) does not survive a child exit.
	 */
	readonly kindRunner: ToolChildKindRunner = async (kind, args, call) => {
		await this.#ensureLive();
		const generation = this.#client.generation;
		const pid = this.#client.pid ?? -1;
		const value = await this.#client.run(kind, args, call.signal, {
			hostContext: { toolCallId: call.toolCallId },
			...(call.onUpdate === undefined ? {} : { onUpdate: call.onUpdate }),
		});
		return { value, pid, generation };
	};

	async #runOnce(job: ToolChildModuleJob, signal: AbortSignal | undefined): Promise<ToolChildRunResult> {
		await this.#ensureLive();
		const generation = this.#client.generation;
		const pid = this.#client.pid ?? -1;
		const deadlineMs = job.deadlineMs ?? fixtureDeadline(job.export, this.#options.env ?? process.env);
		const value = await this.#client.run(MODULE_JOB_KIND, job, signal, {
			idempotent: job.idempotent === true,
			hostContext: { toolCallId: callingToolCallId(job.args) },
			...(deadlineMs === undefined ? {} : { deadlineMs }),
		});
		return { value, pid, generation };
	}

	row(): SessionToolChildRow {
		const state = this.#client.state;
		if (this.#last === undefined) return { state: "none" };
		if (state === "live") return { state: "live", generation: this.#client.generation, pid: this.#last.pid };
		return { state: "exited", generation: this.#last.generation, pid: this.#last.pid };
	}

	async close(): Promise<void> {
		this.#closed = true;
		await this.#starting?.catch(() => undefined);
		await this.#client.close();
		await this.#client.ended();
	}

	async #ensureLive(): Promise<void> {
		if (this.#closed) throw new ToolChildError("tool_child_unavailable", "the session is closed");
		if (this.#client.state === "live") return;
		if (this.#crashLoop.unavailable())
			throw new ToolChildError("tool_child_unavailable", "the tool child keeps exiting; it is paused for a minute");
		this.#starting ??= this.#client
			.start()
			.catch((error: unknown) => {
				// A child that dies before ready is an exit too: it counts toward the crash loop.
				this.#crashLoop.recordExit();
				throw error;
			})
			.finally(() => {
				this.#starting = undefined;
			});
		await this.#starting;
	}

	#onStatus(status: ToolChildStatus): void {
		if (status.state === "spawned") {
			const respawn = this.#last !== undefined;
			this.#last = { generation: status.generation, pid: status.pid };
			this.#options.onRecord({
				state: respawn ? "respawned" : "spawned",
				generation: status.generation,
				pid: status.pid,
			});
			return;
		}
		this.#crashLoop.recordExit();
		this.#options.onRecord({ state: "exited", generation: status.generation, pid: status.pid });
	}
}

/** The tool call a module job runs for (the dispatcher puts it in the job's arguments); undefined for other jobs. */
function callingToolCallId(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const toolCallId: unknown = Reflect.get(args, "toolCallId");
	return typeof toolCallId === "string" ? toolCallId : undefined;
}
