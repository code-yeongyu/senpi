/**
 * What a session's tool child can reach on the server (senpi#3566 todo 7, DESIGN PART 1): a call from a child-run tool
 * body. A `tool` call runs as a nested call of the tool call that owns the job - the same path as in-process
 * `ctx.executeTool`, hooks once - and `list_tools` names the tools such a call may reach. `authorize` asks the session's
 * filesystem policy (never cached: every call is decided again). `lock_file` takes the file's slot in the same mutation
 * queue the session's own file tools use, granted only to a live job; the slot is released only by `unlock_file` or
 * by the child's observed exit - never by a cancel, so a write still in flight finishes before anyone else's begins.
 */
import type { AgentToolCallOutcome } from "@earendil-works/pi-agent-core";
import type { HostCallHandler } from "../modes/rpc/tool-child/host-calls-server.ts";
import type { FilesystemPolicyChecker, FilesystemPolicyDecision, FilesystemPolicyRequest } from "./extensions/types.ts";
import { acquireFileMutationLock, type FileMutationLock } from "./tools/file-mutation-queue.ts";
import { canonicalizeFilesystemPath } from "./tools/filesystem-policy.ts";
import { resolveToCwd } from "./tools/path-utils.ts";

export interface SessionHostCallDeps {
	/** The session cwd: a child's relative path names the same file the session's own file tools would. */
	readonly cwd: string;
	/** Runs `name` as a nested call of `parentToolCallId` through the session's tool pipeline. */
	readonly executeNested: (
		parentToolCallId: string,
		name: string,
		args: unknown,
		signal: AbortSignal,
	) => Promise<AgentToolCallOutcome>;
	readonly callableToolNames: () => readonly string[];
	/** The `completion` / `reserved` targets registered on the session (codemode's runtime registers them). */
	readonly target: (kind: RegisteredHostCallKind) => HostCallTarget | undefined;
	/** The session's composed filesystem policy; undefined when no extension registered one. */
	readonly filesystemPolicy: () => FilesystemPolicyChecker | undefined;
}

export type RegisteredHostCallKind = "completion" | "reserved";

/** Serves one registered kind on the server; it runs with whatever server-side context its registrar holds. */
export type HostCallTarget = (request: {
	readonly name: string | undefined;
	readonly args: unknown;
	readonly signal: AbortSignal;
}) => Promise<unknown>;

export class HostCallError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(`${code}: ${message}`);
		this.name = "HostCallError";
		this.code = code;
	}
}

const ALLOW: FilesystemPolicyDecision = { allow: true };

export function createSessionHostCallHandler(deps: SessionHostCallDeps): HostCallHandler {
	const locks = new Map<string, FileMutationLock>();
	let nextLock = 0;
	const releaseLock = (lockId: string): boolean => {
		const release = locks.get(lockId);
		if (release === undefined) return false;
		locks.delete(lockId);
		release();
		return true;
	};
	return async (request) => {
		// A call of an ended job never runs (it could still spend tokens); only releasing a lock it holds is allowed.
		if (request.kind !== "unlock_file" && !request.generation.jobLive())
			throw new HostCallError("host_call_job_ended", `${request.kind}: the job has ended`);
		switch (request.kind) {
			case "tool": {
				const parent = callingToolCallId(request.context);
				if (parent === undefined) throw new HostCallError("host_call_no_caller", "the job runs for no tool call");
				if (request.name === undefined) throw new HostCallError("host_call_no_name", "a tool call names no tool");
				const outcome = await deps.executeNested(parent, request.name, request.args, request.signal);
				return { result: outcome.result, isError: outcome.isError };
			}
			case "list_tools":
				return [...deps.callableToolNames()];
			case "completion":
			case "reserved": {
				const target = deps.target(request.kind);
				if (target === undefined)
					throw new HostCallError(
						"host_call_unsupported_kind",
						`no ${request.kind} target is registered on this session`,
					);
				return target({ name: request.name, args: request.args, signal: request.signal });
			}
			case "authorize": {
				const policyArgs = await policyRequest(request.args, deps.cwd);
				const policy = deps.filesystemPolicy();
				return policy === undefined ? ALLOW : policy(policyArgs);
			}
			case "lock_file": {
				const path = stringField(request.args, "path");
				const release = await acquireFileMutationLock(resolveToCwd(path, deps.cwd), request.signal);
				// Granted only to a live job: one that ended while it waited never holds the slot.
				if (!request.generation.jobLive() || request.signal.aborted) {
					release();
					throw new HostCallError("host_call_job_ended", `lock on ${path}: the job ended while it waited`);
				}
				const lockId = `L${++nextLock}`;
				locks.set(lockId, release);
				void request.generation.exited.then(() => releaseLock(lockId));
				void request.generation.stuck?.then((holder) => {
					if (locks.get(lockId) === release) release.markStuck(holder);
				});
				return { lockId };
			}
			case "unlock_file": {
				const lockId = stringField(request.args, "lockId");
				if (!releaseLock(lockId)) throw new HostCallError("host_call_unknown_lock", `no held lock ${lockId}`);
				return null;
			}
		}
	};
}

function stringField(args: unknown, field: string): string {
	const value: unknown = typeof args === "object" && args !== null ? Reflect.get(args, field) : undefined;
	if (typeof value !== "string" || value === "")
		throw new HostCallError("host_call_bad_args", `${field} must be a non-empty string`);
	return value;
}

const OPERATIONS: ReadonlySet<string> = new Set(["read", "enumerate", "write"]);

/** The server canonicalizes the child's path the way the built-in file tools do; a child-sent canonical path is never trusted. */
async function policyRequest(args: unknown, cwd: string): Promise<FilesystemPolicyRequest> {
	const operation = stringField(args, "operation");
	if (!OPERATIONS.has(operation))
		throw new HostCallError("host_call_bad_args", `operation must be read, enumerate or write`);
	return {
		operation: operation as FilesystemPolicyRequest["operation"],
		canonicalPath: await canonicalizeFilesystemPath(resolveToCwd(stringField(args, "path"), cwd)),
		toolName: stringField(args, "toolName"),
	};
}

function callingToolCallId(context: unknown): string | undefined {
	if (typeof context !== "object" || context === null) return undefined;
	const toolCallId: unknown = Reflect.get(context, "toolCallId");
	return typeof toolCallId === "string" ? toolCallId : undefined;
}
