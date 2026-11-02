/**
 * Tool dispatch seam (senpi#3566): the single place a tool call is resolved to a
 * placement and executed, and where user bash (`!`, RPC `bash`) resolves its
 * BashOperations.
 *
 * The dispatcher kind follows the session's tool runtime (`--tool-runtime`, absent
 * = in-process). Nothing moves yet: `InProcessToolDispatcher` calls
 * `definition.execute` exactly as the wrappers did before, and `ChildToolDispatcher`
 * refuses child-placed work with `tool_runtime_unavailable` until the tool child
 * runtime lands (senpi#3566 todo 4). An explicit `operations` override stays with
 * its caller, so caller-injected work is never re-routed.
 */
import { dirname, isAbsolute, resolve } from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ToolRuntimeKind } from "../../cli/tool-runtime.ts";
import type { HostCallHandler } from "../../modes/rpc/tool-child/host-calls-server.ts";
import { kernelToolInvokerStorage } from "../extensions/kernel-tools-context.ts";
import type { ExtensionToolContext, ToolChildJob, ToolDefinition, ToolPlacement } from "../extensions/types.ts";
import { type BashOperations, createLocalBashOperations } from "../tools/bash.ts";
import { childBashOperations } from "./child-bash-operations.ts";
import { type InProcessRun, runModuleInProcess, type StuckModuleNotice } from "./in-process-module.ts";
import { OffloadError } from "./offload.ts";

export type { ToolPlacement } from "../extensions/types.ts";

export const TOOL_RUNTIME_UNAVAILABLE = "tool_runtime_unavailable";

export interface ToolUnavailableDetails {
	readonly code: typeof TOOL_RUNTIME_UNAVAILABLE;
}

export interface ToolDispatchedInfo {
	readonly toolCallId: string;
	readonly placement: ToolPlacement;
	readonly pid: number;
	readonly generation: number;
}

export type ToolDispatchObserver = (info: ToolDispatchedInfo) => void;

export type ToolDispatchNotify = (event: string, data?: Record<string, unknown>) => void;

export interface ToolDispatchCall<TDetails = unknown> {
	readonly definition: ToolDefinition<any, TDetails>;
	readonly toolCallId: string;
	readonly params: unknown;
	readonly signal?: AbortSignal;
	readonly onUpdate?: AgentToolUpdateCallback<TDetails>;
	readonly ctx: ExtensionToolContext;
	/** The extension file that registered the tool; a relative `childModule.path` resolves against its directory. */
	readonly sourcePath?: string;
}

/** The tool child's `module` job (senpi#3566; the same shape todo 8's `ctx.offload` uses). */
export interface ToolChildModuleJob {
	readonly modulePath: string;
	readonly export: string;
	readonly args: unknown;
	/** A lost job is retried once on a fresh child only when this is true. */
	readonly idempotent?: boolean;
	/** Overrides the job's default deadline (`ctx.offload`'s `deadlineMs`). */
	readonly deadlineMs?: number;
}

/** Where an offloaded module ran, and what it returned. */
export interface OffloadOutcome {
	readonly value: unknown;
	readonly placement: ToolPlacement;
	readonly pid: number;
	readonly generation: number;
}

export interface ToolChildRunResult {
	readonly value: unknown;
	readonly pid: number;
	readonly generation: number;
}

/** Runs a job of a built-in kind on the session's tool child (`ToolDefinition.childJob`), streaming its updates. */
export type ToolChildKindRunner = (
	kind: string,
	args: unknown,
	call: {
		readonly toolCallId: string;
		readonly signal: AbortSignal | undefined;
		readonly onUpdate?: (value: unknown) => void;
	},
) => Promise<ToolChildRunResult>;

/** Runs a `module` job on the session's tool child, starting the child on first use. */
export type ToolChildRunner = (job: ToolChildModuleJob, signal: AbortSignal | undefined) => Promise<ToolChildRunResult>;

export interface ToolDispatcherOptions {
	runtime: ToolRuntimeKind;
	notify?: ToolDispatchNotify;
	childRunner?: ToolChildRunner;
	childKindRunner?: ToolChildKindRunner;
	/** The session's host-call handler: an in-process `ctx.offload` module gets the same host the child's worker builds. */
	hostCalls?: HostCallHandler;
	/** How long past its deadline an in-process module may run before it is reported stuck (default 10 s). */
	stuckGraceMs?: number;
	/** Told when an in-process module is stuck (it keeps its locks; their waiters fail fast). */
	onModuleStuck?: (notice: StuckModuleNotice) => void;
}

export interface ToolDispatcher {
	readonly kind: ToolRuntimeKind;
	run<TDetails = unknown>(
		call: ToolDispatchCall<TDetails>,
	): Promise<AgentToolResult<TDetails | ToolUnavailableDetails>>;
	bashOperations(options?: { shellPath?: string }): BashOperations;
	onDispatched(observer: ToolDispatchObserver): () => void;
	/** Runs a registered child module (`ctx.offload`) where this runtime places it. */
	offload(job: ToolChildModuleJob, signal: AbortSignal | undefined): Promise<OffloadOutcome>;
	/** The session is closed or replaced: work this runtime still runs in this process is closed; settles once it let go. */
	dispose(): Promise<void>;
}

type InProcessDispatchOptions = Pick<ToolDispatcherOptions, "hostCalls" | "stuckGraceMs" | "onModuleStuck">;

/**
 * Placement of one call: only a definition that opted into `"child"` while the
 * session runs the child runtime dispatches there, and never when the definition
 * is server-pinned (injected `operations` / policy override captured at creation).
 */
export function resolveToolPlacement(
	definition: Pick<ToolDefinition, "name" | "placement" | "serverPinned">,
	runtime: ToolRuntimeKind,
): ToolPlacement {
	if (runtime !== "child") return "server";
	if (definition.placement !== "child") return "server";
	if (definition.serverPinned === true) return "server";
	return "child";
}

abstract class BaseToolDispatcher implements ToolDispatcher {
	abstract readonly kind: ToolRuntimeKind;

	abstract run<TDetails>(
		call: ToolDispatchCall<TDetails>,
	): Promise<AgentToolResult<TDetails | ToolUnavailableDetails>>;

	abstract bashOperations(options?: { shellPath?: string }): BashOperations;

	dispose(): Promise<void> {
		return Promise.resolve();
	}

	abstract offload(job: ToolChildModuleJob, signal: AbortSignal | undefined): Promise<OffloadOutcome>;

	private readonly observers = new Set<ToolDispatchObserver>();
	private readonly pinNotified = new Set<string>();
	private readonly notifySink: ToolDispatchNotify | undefined;

	constructor(notify?: ToolDispatchNotify) {
		this.notifySink = notify;
	}

	onDispatched(observer: ToolDispatchObserver): () => void {
		this.observers.add(observer);
		return () => {
			this.observers.delete(observer);
		};
	}

	protected placementFor(definition: Pick<ToolDefinition, "name" | "placement" | "serverPinned">): ToolPlacement {
		const placement = resolveToolPlacement(definition, this.kind);
		if (placement === "server" && this.kind === "child" && definition.placement === "child") {
			if (!this.pinNotified.has(definition.name)) {
				this.pinNotified.add(definition.name);
				this.notifySink?.("tool_placement_pinned", { tool: definition.name, reason: "server_pinned" });
			}
		}
		return placement;
	}

	protected runOnServer<TDetails>(call: ToolDispatchCall<TDetails>): Promise<AgentToolResult<TDetails>> {
		this.emitDispatched({ toolCallId: call.toolCallId, placement: "server", pid: process.pid, generation: 0 });
		const execute = () => call.definition.execute(call.toolCallId, call.params, call.signal, call.onUpdate, call.ctx);
		// Context-free wrappers and child/observer contexts have no host identity.
		// Do not read an absent capability or inherit another dispatch's invoker.
		const manager = call.ctx && "sessionManager" in call.ctx ? call.ctx.sessionManager : undefined;
		return manager
			? kernelToolInvokerStorage.run({ sessionId: manager.getSessionId() }, execute)
			: kernelToolInvokerStorage.exit(execute);
	}

	protected emitDispatched(info: ToolDispatchedInfo): void {
		for (const observer of [...this.observers]) {
			try {
				observer(info);
			} catch (error) {
				// An observer is diagnostics only: its failure must never become the tool call's failure.
				this.notifySink?.("tool_dispatch_observer_failed", {
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
}

export class InProcessToolDispatcher extends BaseToolDispatcher {
	readonly kind: ToolRuntimeKind = "in-process";
	readonly #options: InProcessDispatchOptions;
	readonly #live = new Set<InProcessRun>();
	#disposed = false;

	constructor(notify?: ToolDispatchNotify, options: InProcessDispatchOptions = {}) {
		super(notify);
		this.#options = options;
	}

	/** Closes every in-process module run still live; settles once each has released its locks (`InProcessRun.close`). */
	override async dispose(): Promise<void> {
		this.#disposed = true;
		await Promise.all([...this.#live].map((run) => run.close()));
	}

	run<TDetails>(call: ToolDispatchCall<TDetails>): Promise<AgentToolResult<TDetails>> {
		return this.runOnServer(call);
	}

	bashOperations(options?: { shellPath?: string }): BashOperations {
		return createLocalBashOperations(options);
	}

	async offload(job: ToolChildModuleJob, signal: AbortSignal | undefined): Promise<OffloadOutcome> {
		if (this.#disposed) throw new OffloadError("offload_session_closed", `${job.modulePath}: the session was closed`);
		return {
			value: await runModuleInProcess(job, signal, {
				...(this.#options.hostCalls === undefined ? {} : { hostCalls: this.#options.hostCalls }),
				...(this.#options.stuckGraceMs === undefined ? {} : { stuckGraceMs: this.#options.stuckGraceMs }),
				...(this.#options.onModuleStuck === undefined ? {} : { onStuck: this.#options.onModuleStuck }),
				live: this.#live,
			}),
			placement: "server",
			pid: process.pid,
			generation: 0,
		};
	}
}

/**
 * Refuses child-placed work and child-backed bash until the tool child runtime
 * lands (senpi#3566 todo 4 / todo 9); server-placed work still runs in-process,
 * so a session under `--tool-runtime child` stays usable at this stage.
 */
export class ChildToolDispatcher extends BaseToolDispatcher {
	readonly kind: ToolRuntimeKind = "child";
	readonly #childRunner: ToolChildRunner | undefined;
	readonly #kindRunner: ToolChildKindRunner | undefined;

	constructor(notify?: ToolDispatchNotify, childRunner?: ToolChildRunner, kindRunner?: ToolChildKindRunner) {
		super(notify);
		this.#childRunner = childRunner;
		this.#kindRunner = kindRunner;
	}

	run<TDetails>(call: ToolDispatchCall<TDetails>): Promise<AgentToolResult<TDetails | ToolUnavailableDetails>> {
		if (this.placementFor(call.definition) === "server") {
			return this.runOnServer(call);
		}
		const childJob = call.definition.childJob;
		if (childJob !== undefined) {
			const where = childJob.placement?.(call.params) ?? "child";
			if (where === "server") return this.runOnServer(call);
			if (this.#kindRunner === undefined) return Promise.resolve(unavailableToolResult(call.definition.name));
			if (where === "both") return this.#runOnBoth(this.#kindRunner, childJob, call);
			return this.#runKind(this.#kindRunner, childJob, call);
		}
		const job = childModuleJob(call);
		if (job === undefined || this.#childRunner === undefined)
			return Promise.resolve(unavailableToolResult(call.definition.name));
		return this.#runOnChild(this.#childRunner, job, call);
	}

	/** The server's body first (its own state), then the child's job; the result carries both contents, the child's details. */
	async #runOnBoth<TDetails>(
		runner: ToolChildKindRunner,
		childJob: ToolChildJob,
		call: ToolDispatchCall<TDetails>,
	): Promise<AgentToolResult<TDetails>> {
		const local = await this.runOnServer(call);
		const remote = await this.#runKind(runner, childJob, call);
		return { ...remote, content: [...local.content, ...remote.content] };
	}

	async #runKind<TDetails>(
		runner: ToolChildKindRunner,
		childJob: ToolChildJob,
		call: ToolDispatchCall<TDetails>,
	): Promise<AgentToolResult<TDetails>> {
		const onUpdate = call.onUpdate;
		const kind = childJob.kind;
		const args = childJob.args(call.params, call.toolCallId, call.ctx);
		const { value, pid, generation } = await runner(kind, args, {
			toolCallId: call.toolCallId,
			signal: call.signal,
			...(onUpdate === undefined
				? {}
				: {
						onUpdate: (update: unknown) => {
							if (isToolResult<TDetails>(update)) onUpdate(update);
						},
					}),
		});
		this.emitDispatched({ toolCallId: call.toolCallId, placement: "child", pid, generation });
		if (!isToolResult<TDetails>(value))
			throw new Error(`tool_child_invalid_result: ${kind} must return { content: [...] }`);
		if (childJob.result === undefined) return value;
		return childJob.result(call.params, value, generation) as AgentToolResult<TDetails>;
	}

	async #runOnChild<TDetails>(
		runner: ToolChildRunner,
		job: ToolChildModuleJob,
		call: ToolDispatchCall<TDetails>,
	): Promise<AgentToolResult<TDetails>> {
		const { value, pid, generation } = await runner(job, call.signal);
		this.emitDispatched({ toolCallId: call.toolCallId, placement: "child", pid, generation });
		if (!isToolResult<TDetails>(value))
			throw new Error(`tool_child_invalid_result: ${job.modulePath}#${job.export} must return { content: [...] }`);
		return value;
	}

	bashOperations(options?: { shellPath?: string }): BashOperations {
		if (this.#kindRunner === undefined) return unavailableBashOperations();
		return childBashOperations(this.#kindRunner, options);
	}

	/** Always on the session's child, started on demand; never in-process (no fallback). */
	async offload(job: ToolChildModuleJob, signal: AbortSignal | undefined): Promise<OffloadOutcome> {
		if (this.#childRunner === undefined)
			throw new OffloadError("tool_runtime_unavailable", "this session has no tool child to run the module on");
		const { value, pid, generation } = await this.#childRunner(job, signal);
		return { value, placement: "child", pid, generation };
	}
}

export function createToolDispatcher(options: ToolDispatcherOptions): ToolDispatcher {
	return options.runtime === "child"
		? new ChildToolDispatcher(options.notify, options.childRunner, options.childKindRunner)
		: new InProcessToolDispatcher(options.notify, options);
}

function childModuleJob(call: {
	readonly definition: Pick<ToolDefinition, "childModule">;
	readonly params: unknown;
	readonly toolCallId: string;
	readonly sourcePath?: string;
}): ToolChildModuleJob | undefined {
	const childModule = call.definition.childModule;
	if (childModule === undefined) return undefined;
	const base = call.sourcePath === undefined ? undefined : dirname(call.sourcePath);
	if (!isAbsolute(childModule.path) && base === undefined) return undefined;
	const modulePath = isAbsolute(childModule.path) ? childModule.path : resolve(base ?? "", childModule.path);
	return { modulePath, export: childModule.export, args: { params: call.params, toolCallId: call.toolCallId } };
}

function isToolResult<TDetails>(value: unknown): value is AgentToolResult<TDetails> {
	return typeof value === "object" && value !== null && Array.isArray(Reflect.get(value, "content"));
}

export function unavailableToolResult(toolName: string): AgentToolResult<ToolUnavailableDetails> {
	return {
		content: [
			{
				type: "text",
				text: `${TOOL_RUNTIME_UNAVAILABLE}: tool "${toolName}" is placed on the session tool child, which this build does not provide yet (senpi#3566).`,
			},
		],
		details: { code: TOOL_RUNTIME_UNAVAILABLE },
		isError: true,
	};
}

export function unavailableBashOperations(): BashOperations {
	return {
		exec: async () => {
			throw new Error(
				`${TOOL_RUNTIME_UNAVAILABLE}: user bash needs the session tool child, which this build does not provide yet (senpi#3566)`,
			);
		},
	};
}
