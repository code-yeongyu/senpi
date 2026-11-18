/**
 * One served op under the scope the relay host decided (its `executor.ts` run step, ported). A confined scope gives
 * machine-ops its root, so any path or symlink resolving outside it fails policy_denied. An unconfined scope (a device's
 * default) gives no root: relative fs paths and glob's cwd are anchored at the root here, the OS user's permissions
 * decide, and an OS refusal (EACCES, EPERM, EROFS) fails os_permission_denied naming the errno, the path and the fix.
 * The relay host already decided the op (admission, grants, consent), so the engine adds no policy of its own beyond
 * one owner rule (review L1): an op naming a terminal handle acts only on its own sender's handle, unless the relay host
 * marked it `cross_owner` after its admin verdict; another sender's handle fails `not_owner`.
 */
import { resolve } from "node:path";
import { MachineOpError, type MachineOps, opErrorCode } from "@code-yeongyu/senpi-machine-ops";
import { type OpCall, servedOp } from "./op-registry.ts";
import type { TerminalOps } from "./terminal-ops.ts";
import type { Args, MachineOpRequest, OpError, OpOutcome } from "./wire.ts";

const ERROR_MESSAGE_MAX = 1_024;
const OS_REFUSALS: ReadonlySet<string> = new Set(["EACCES", "EPERM", "EROFS"]);

const osRefusal = (error: unknown): OpError | undefined => {
	if (!(error instanceof Error) || error instanceof MachineOpError) return undefined;
	const errno = Reflect.get(error, "code");
	if (typeof errno !== "string" || !OS_REFUSALS.has(errno)) return undefined;
	const path = Reflect.get(error, "path");
	const syscall = Reflect.get(error, "syscall");
	const what = typeof path === "string" ? ` ${path}` : "";
	const verb = typeof syscall === "string" ? syscall : "access";
	return {
		code: "os_permission_denied",
		message:
			`${errno}: this device's OS user may not ${verb}${what}. Use a path that user can access, or change its permissions on that device.`.slice(
				0,
				ERROR_MESSAGE_MAX,
			),
	};
};

const anchored = (op: string, args: Args, root: string): Args => {
	if (!op.startsWith("fs.")) return args;
	const { path, cwd } = args;
	return {
		...args,
		...(typeof path === "string" ? { path: resolve(root, path) } : {}),
		...(op === "fs.glob" ? { cwd: resolve(root, typeof cwd === "string" ? cwd : ".") } : {}),
	};
};

const failure = (error: unknown, confined: boolean): OpOutcome => {
	const os = confined ? undefined : osRefusal(error);
	if (os !== undefined) return { state: "failed", error: os };
	const code = opErrorCode(error);
	const message = (error instanceof Error ? error.message : String(error)).slice(0, ERROR_MESSAGE_MAX);
	return code === "aborted"
		? { state: "cancelled", error: { code, message } }
		: { state: "failed", error: { code, message } };
};

export interface ExecutorDeps {
	readonly ops: MachineOps;
	readonly terminal: TerminalOps;
	readonly pidOf: (handleId: string) => number | undefined;
	readonly ownerOf: (handleId: string) => string | undefined;
}

const foreignHandle = (
	request: MachineOpRequest,
	handleArg: string | undefined,
	deps: ExecutorDeps,
): string | undefined => {
	const handle = handleArg === undefined ? undefined : request.args[handleArg];
	if (typeof handle !== "string" || request.crossOwner) return undefined;
	const owner = deps.ownerOf(handle);
	return owner !== undefined && owner !== request.sender ? handle : undefined;
};

export async function runMachineOp(
	request: MachineOpRequest,
	signal: AbortSignal,
	deps: ExecutorDeps,
): Promise<OpOutcome> {
	const entry = servedOp(request.op);
	if (entry === undefined)
		return { state: "refused", error: { code: "malformed", message: `unknown op ${request.op}` } };
	const foreign = foreignHandle(request, entry.handleArg, deps);
	if (foreign !== undefined)
		return { state: "failed", error: { code: "not_owner", message: `handle ${foreign} belongs to another sender` } };
	const { root, confined } = request.scope;
	const call: OpCall = {
		ctx: {
			scope: { id: `${request.sender}/omo`, ...(confined ? { root } : {}) },
			principal: { kind: "remote-device", id: request.sender },
			signal,
			limits: deps.ops.limits,
			policy: {},
		},
		ops: deps.ops,
		root,
		confined,
		envOverlay: request.envOverlay,
		sender: request.sender,
		signal,
		terminal: deps.terminal,
		pidOf: deps.pidOf,
	};
	try {
		return await entry.run(confined ? request.args : anchored(request.op, request.args, root), call);
	} catch (error) {
		return failure(error, confined);
	}
}
