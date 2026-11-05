import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import {
	type NestedRequest,
	type AgentToolResult,
	base64Length,
	type DeviceFileArgs,
	DeviceFileError,
	decodeBase64,
	decodeDeviceFileArgs,
	encodeBase64,
	FILE_CHANNEL_MAX_BYTES,
	fileRefusal,
	fileResult,
} from "@earendil-works/pi-agent-core";
import { localDeviceFiles } from "@earendil-works/pi-agent-core/node";
import type { FilesystemOperation, FilesystemPolicyChecker } from "../../core/extensions/types.ts";
import { withFileMutationQueue, withFileMutationQueues } from "../../core/tools/file-mutation-queue.ts";
import { canonicalizeFilesystemPath } from "../../core/tools/filesystem-policy.ts";
import type { Flock } from "./hand-activity-lock.ts";
import type { HandRunContext } from "./hand-run-allowlist.ts";
import { runOnHand } from "./hand-run-ops.ts";

/** What a hand scope checks every device file operation against: its runtime's handlers and filesystem policy. */
export interface HandFileGuards {
	beforeToolCall(
		toolName: string,
		toolCallId: string,
		input: Record<string, unknown>,
		/** The operation's nested requests to the loop: a two-sided extension's handler runs on the loop's copy (S29). */
		nested?: NestedRequest,
	): Promise<{ readonly block?: boolean; readonly reason?: string } | undefined>;
	filesystemPolicy(): FilesystemPolicyChecker | undefined;
}

interface Check {
	readonly toolName: "read" | "ls" | "write";
	readonly operation: FilesystemOperation;
	readonly path: string;
	readonly content?: string;
	/** Acts on the directory entry itself (a link, not its target), as the local filesystem does. */
	readonly entry?: true;
}

function checksOf(args: Exclude<DeviceFileArgs, { op: "run" }>): Check[] {
	switch (args.op) {
		case "read":
			return [{ toolName: "read", operation: "read", path: args.path }];
		case "list":
			return [{ toolName: "ls", operation: "enumerate", path: args.path }];
		case "stat":
			return [{ toolName: "ls", operation: "enumerate", path: args.path, entry: true }];
		case "write":
			return [
				{
					toolName: "write",
					operation: "write",
					path: args.path,
					content: new TextDecoder().decode(decodeBase64(args.data)),
				},
			];
		case "rename":
			return [
				{ toolName: "write", operation: "write", path: args.path, content: "", entry: true },
				{ toolName: "write", operation: "write", path: args.to, content: "", entry: true },
			];
		case "remove":
			return [{ toolName: "write", operation: "write", path: args.path, content: "", entry: true }];
		case "mkdir":
			return [{ toolName: "write", operation: "write", path: args.path, content: "" }];
	}
}

async function canonicalOf(path: string, entry: boolean): Promise<string> {
	return entry
		? join(await canonicalizeFilesystemPath(dirname(path)), basename(path))
		: canonicalizeFilesystemPath(path);
}

async function allowed(
	guards: HandFileGuards,
	root: string,
	check: Check,
	nested: NestedRequest | undefined,
): Promise<string> {
	const content = check.content ?? "";
	const input: Record<string, unknown> =
		check.toolName === "write" ? { path: check.path, content } : { path: check.path };
	let decision: Awaited<ReturnType<HandFileGuards["beforeToolCall"]>>;
	try {
		decision = await guards.beforeToolCall(check.toolName, `file-${randomUUID()}`, input, nested);
	} catch (error) {
		throw new DeviceFileError("refused_by_policy", error instanceof Error ? error.message : String(error));
	}
	if (decision?.block === true) throw new DeviceFileError("refused_by_policy", decision.reason ?? "blocked");
	// A handler may patch a tool's input in place; a file operation does not follow a patched path or content.
	if (input.path !== check.path || (check.toolName === "write" && input.content !== content))
		throw new DeviceFileError("refused_by_policy", "a tool_call handler rewrote the operation");
	const canonicalPath = await canonicalOf(resolve(root, check.path), check.entry === true);
	const verdict = await guards.filesystemPolicy()?.({
		operation: check.operation,
		canonicalPath,
		toolName: check.toolName,
	});
	if (verdict !== undefined && !verdict.allow) throw new DeviceFileError("refused_by_policy", verdict.reason);
	return canonicalPath;
}

/**
 * One hand scope's device file operations (S40, senpi#5645). Paths resolve against the scope root and are NOT confined
 * to it: they are bounded by the hand's OS user, its filesystem policy and its `tool_call` handlers, which see each
 * operation as the matching file tool (`read`, `ls`, `write`) with that tool's input shape; a block, a throw or a
 * patched input refuses it. The operation then runs on exactly the canonical path the policy checked, in the same
 * per-file mutation slot the file tools use; `stat`, `remove` and `rename` act on a link itself, as on a fused session.
 * A write over the limit is refused before its data is decoded.
 */
export function createHandFileOps(
	root: string,
	guards: HandFileGuards,
	run?: { readonly context: HandRunContext; readonly flock: Flock | undefined },
) {
	const files = localDeviceFiles();
	return async (
		op: string,
		rawArgs: unknown,
		signal: AbortSignal,
		nested?: NestedRequest,
	): Promise<AgentToolResult<unknown>> => {
		const args = decodeDeviceFileArgs(op, rawArgs);
		if (args === undefined) return fileRefusal("protocol", `malformed ${op} arguments`);
		if (args.op === "run") {
			if (run === undefined) return fileRefusal("unsupported", "this hand serves no run channel");
			try {
				const { exe, argv, env, stdin, timeoutMs, activityLock } = args;
				const request = {
					exe,
					argv,
					cwd: args.path,
					env,
					activityLock,
					...(stdin === undefined ? {} : { stdin }),
					...(timeoutMs === undefined ? {} : { timeoutMs }),
				};
				const outcome = await runOnHand(
					request,
					{ root, guards, context: run.context, flock: run.flock, ...(nested ? { nested } : {}) },
					signal,
				);
				return fileResult({ ok: true, value: { ...outcome } });
			} catch (error) {
				if (error instanceof DeviceFileError) return fileRefusal(error.code, error.message);
				return fileRefusal("io", error instanceof Error ? error.message : String(error));
			}
		}
		if (args.op === "write" && base64Length(args.data) > FILE_CHANNEL_MAX_BYTES)
			return fileRefusal("too_large", args.path);
		try {
			const [target, destination] = await Promise.all(
				checksOf(args).map((check) => allowed(guards, root, check, nested)),
			);
			if (target === undefined) return fileRefusal("protocol", "no target");
			const options = { signal };
			switch (args.op) {
				case "read":
					return fileResult({ ok: true, value: encodeBase64(await files.read(target, options)) });
				case "list":
					return fileResult({ ok: true, value: [...(await files.list(target, options))] });
				case "stat":
					return fileResult({ ok: true, value: { ...(await files.stat(target, options)) } });
				case "write": {
					const data = decodeBase64(args.data);
					await withFileMutationQueue(target, () =>
						files.write(target, data, { ...options, exclusive: args.exclusive }),
					);
					break;
				}
				case "rename":
					await withFileMutationQueues([target, destination ?? target], () =>
						files.rename(target, destination ?? target, options),
					);
					break;
				case "remove":
					await withFileMutationQueue(target, () => files.remove(target, options));
					break;
				case "mkdir":
					await files.mkdir(target, options);
					break;
			}
			return fileResult({ ok: true, value: null });
		} catch (error) {
			if (error instanceof DeviceFileError) return fileRefusal(error.code, error.message);
			return fileRefusal("io", error instanceof Error ? error.message : String(error));
		}
	};
}
