import { isAbsolute, relative, resolve, sep } from "node:path";
import { MachineOpError } from "../errors.ts";
import type { OpContext, OpName, OpOutcome } from "../types.ts";
import { canonicalizeFilesystemPath, type FilesystemOperation } from "./filesystem.ts";

/** Resolve a request path against the scope root (or the process cwd when the scope has none). */
export function resolveOpPath(path: string, ctx: OpContext): string {
	return resolve(ctx.scope.root ?? process.cwd(), path);
}

function contains(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Containment and filesystem policy for one path, before any effect. A path (or a symlink in it) resolving outside
 * `ctx.scope.root` is a denial. With neither a root nor a filesystem policy the path is not canonicalized at all.
 */
export async function checkPath(
	absolutePath: string,
	operation: FilesystemOperation,
	op: OpName,
	ctx: OpContext,
): Promise<void> {
	const root = ctx.scope.root;
	const filesystem = ctx.policy.filesystem;
	if (root === undefined && filesystem === undefined) return;
	const canonicalPath = await canonicalizeFilesystemPath(absolutePath);
	if (root !== undefined && !contains(await canonicalizeFilesystemPath(root), canonicalPath)) {
		ctx.audit?.({ op, principal: ctx.principal, target: canonicalPath, verdict: "denied" });
		throw new MachineOpError("policy_denied", `${absolutePath} is outside the scope root`);
	}
	if (filesystem !== undefined) {
		const decision = await filesystem({ operation, canonicalPath, toolName: op });
		if (!decision.allow) {
			ctx.audit?.({ op, principal: ctx.principal, target: canonicalPath, verdict: "denied" });
			throw new MachineOpError("policy_denied", decision.reason);
		}
	}
}

/** Run `beforeOp`, the effect, then `afterOp`. A denial throws before the effect runs. */
export async function gated<T>(op: OpName, args: unknown, ctx: OpContext, effect: () => Promise<T>): Promise<T> {
	if (ctx.signal.aborted) throw new MachineOpError("aborted", "Operation aborted", { cause: ctx.signal.reason });
	if (ctx.policy.beforeOp !== undefined) {
		const decision = await ctx.policy.beforeOp(op, args, ctx);
		if (!decision.allow) {
			ctx.audit?.({ op, principal: ctx.principal, target: describeTarget(args), verdict: "denied" });
			throw new MachineOpError("policy_denied", decision.reason);
		}
	}
	ctx.audit?.({ op, principal: ctx.principal, target: describeTarget(args), verdict: "allowed" });
	let value: T;
	try {
		value = await effect();
	} catch (error) {
		await notifyAfter(op, args, { ok: false, error }, ctx);
		throw error;
	}
	await notifyAfter(op, args, { ok: true, value }, ctx);
	return value;
}

async function notifyAfter(op: OpName, args: unknown, outcome: OpOutcome, ctx: OpContext): Promise<void> {
	if (ctx.policy.afterOp !== undefined) await ctx.policy.afterOp(op, args, outcome, ctx);
}

/** The audit target: a path, or the first 64 characters of a command; never a payload. */
function describeTarget(args: unknown): string {
	if (typeof args !== "object" || args === null) return "";
	const record = args as Record<string, unknown>;
	if (typeof record.path === "string") return record.path;
	if (typeof record.command === "string") return record.command.slice(0, 64);
	if (typeof record.topic === "string") return record.topic;
	return "";
}
