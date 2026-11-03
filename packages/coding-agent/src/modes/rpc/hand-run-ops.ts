import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	base64Length,
	DeviceFileError,
	decodeBase64,
	encodeBase64,
	FILE_CHANNEL_MAX_BYTES,
} from "@earendil-works/pi-agent-core";
import { type Flock, holdActivityLock } from "./hand-activity-lock.ts";
import type { HandFileGuards } from "./hand-file-ops.ts";
import { type HandRunContext, planRun, renderCommand } from "./hand-run-allowlist.ts";
import { confinedIndexFile, gitIsSupported, runDirectory, worktreeTarget } from "./hand-run-checks.ts";

export interface RunArgs {
	readonly exe: string;
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly stdin?: string;
	readonly timeoutMs?: number;
	readonly activityLock?: boolean;
}

export interface RunOutcome {
	readonly code: number | null;
	readonly signal: string | null;
	readonly stdout: string;
	readonly stderr: string;
}

export const RUN_TIMEOUT_CAP_MS = 300_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 10_000;

async function judged(guards: HandFileGuards, command: string): Promise<void> {
	const input: Record<string, unknown> = { command };
	let decision: Awaited<ReturnType<HandFileGuards["beforeToolCall"]>>;
	try {
		decision = await guards.beforeToolCall("bash", `run-${randomUUID()}`, input);
	} catch (error) {
		throw new DeviceFileError("refused_by_policy", error instanceof Error ? error.message : String(error));
	}
	if (decision?.block === true) throw new DeviceFileError("refused_by_policy", decision.reason ?? "blocked");
	if (input.command !== command)
		throw new DeviceFileError("refused_by_policy", "a tool_call handler rewrote the command");
}

/**
 * One `run` on a hand (S40 PR 2, design v2.2-v2.4): the allowlist's exact argv and environment, the scope's handlers
 * judging the rendered command as `bash`, the policy checking `cwd` as a write, `GIT_INDEX_FILE` confined, git's version
 * floor, the activity lock held as fd 3 until the child exits, and no shell. Streams and time are bounded.
 */
export async function runOnHand(
	args: RunArgs,
	deps: {
		readonly root: string;
		readonly guards: HandFileGuards;
		readonly context: HandRunContext;
		readonly flock: Flock | undefined;
	},
	signal: AbortSignal,
): Promise<RunOutcome> {
	const plan = planRun({ exe: args.exe, argv: args.argv, env: args.env }, deps.context);
	if (!plan.ok) throw new DeviceFileError("refused_by_policy", plan.reason);
	if (args.stdin !== undefined && base64Length(args.stdin) > FILE_CHANNEL_MAX_BYTES)
		throw new DeviceFileError("too_large", "stdin");
	const cwd = await runDirectory(deps.root, args.cwd);
	const verdict = await deps.guards.filesystemPolicy()?.({ operation: "write", canonicalPath: cwd, toolName: "bash" });
	if (verdict !== undefined && !verdict.allow) throw new DeviceFileError("refused_by_policy", verdict.reason);
	await judged(deps.guards, renderCommand(plan.exe, plan.argv));
	const env = { ...plan.env };
	if (plan.exe === "git") {
		if (!(await gitIsSupported(env))) throw new DeviceFileError("unsupported", "git 2.29 or newer is required");
		if (env.GIT_INDEX_FILE !== undefined) env.GIT_INDEX_FILE = await confinedIndexFile(env.GIT_INDEX_FILE, cwd, env);
		const worktree = await worktreeTarget(plan.argv, cwd, env);
		const target =
			worktree === undefined
				? undefined
				: await deps.guards.filesystemPolicy()?.({ operation: "write", canonicalPath: worktree, toolName: "bash" });
		if (target !== undefined && !target.allow) throw new DeviceFileError("refused_by_policy", target.reason);
	}
	const hold = args.activityLock === true && plan.exe === "git" ? await holdActivityLock(cwd, deps.flock) : undefined;
	try {
		return await spawnBounded(plan.exe, plan.argv, cwd, env, args, hold?.fd, signal);
	} finally {
		await hold?.release();
	}
}

function spawnBounded(
	exe: string,
	argv: readonly string[],
	cwd: string,
	env: Record<string, string>,
	args: RunArgs,
	lockFd: number | undefined,
	signal: AbortSignal,
): Promise<RunOutcome> {
	return new Promise((done, fail) => {
		const child = spawn(exe, [...argv], {
			cwd,
			env,
			shell: false,
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe", lockFd ?? "ignore"],
		});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let size = { out: 0, err: 0 };
		let overflow = false;
		let killTimer: NodeJS.Timeout | undefined;
		const stop = (): void => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
			// A grandchild (ssh) may hold the pipes after git exits; destroying them lets the run end at its deadline.
			killTimer ??= setTimeout(() => {
				child.kill("SIGKILL");
				child.stdout?.destroy();
				child.stderr?.destroy();
			}, KILL_GRACE_MS);
		};
		const timeout = setTimeout(stop, Math.min(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, RUN_TIMEOUT_CAP_MS));
		const onAbort = (): void => stop();
		signal.addEventListener("abort", onAbort, { once: true });
		const collect = (into: Buffer[], key: "out" | "err") => (chunk: Buffer) => {
			size = { ...size, [key]: size[key] + chunk.length };
			if (size[key] > FILE_CHANNEL_MAX_BYTES) {
				overflow = true;
				stop();
				return;
			}
			into.push(chunk);
		};
		child.stdout?.on("data", collect(out, "out"));
		child.stderr?.on("data", collect(err, "err"));
		child.on("error", (error) => fail(new DeviceFileError("io", error.message)));
		child.on("close", (code, exitSignal) => {
			clearTimeout(timeout);
			if (killTimer !== undefined) clearTimeout(killTimer);
			signal.removeEventListener("abort", onAbort);
			if (signal.aborted) return fail(new DeviceFileError("aborted", "the run was aborted"));
			if (overflow) return fail(new DeviceFileError("too_large", "the run's output passed the limit"));
			done({
				code,
				signal: exitSignal,
				stdout: encodeBase64(new Uint8Array(Buffer.concat(out))),
				stderr: Buffer.concat(err).toString("utf8"),
			});
		});
		child.stdin?.on("error", () => undefined);
		child.stdin?.end(args.stdin === undefined ? undefined : Buffer.from(decodeBase64(args.stdin)));
	});
}
