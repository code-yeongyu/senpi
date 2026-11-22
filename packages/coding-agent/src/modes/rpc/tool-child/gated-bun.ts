/**
 * Bun's launch globals behind the execution barrier, for a tool-child worker on the Bun runtime (senpi#3566, plan
 * todo 4; DESIGN PART 1 per-API table). `Bun.spawn` without `detached` and with `detached: true` leads its own group
 * through the POSIX shim; `Bun.spawnSync` and `Bun.$` stay in the child's ledgered group. The worker blocks until the
 * ack in every case, so the real call and every stdin write happen only after the server recorded the launch.
 */
import { writeSync } from "node:fs";
import { controlFd, goShimScript, withControlPipe } from "./go-shim.ts";
import type { WorkerLaunchClient } from "./worker-launch.ts";

interface BunSubprocess {
	readonly pid: number;
	readonly exited: Promise<number>;
	readonly stdin?: { write(chunk: string): unknown; end(): unknown; flush?(): unknown } | number | null;
}

interface BunSpawnOptions {
	readonly cmd?: readonly string[];
	readonly stdin?: unknown;
	readonly detached?: boolean;
	readonly [key: string]: unknown;
}

export interface BunLaunchGlobals {
	spawn(commandOrOptions: readonly string[] | BunSpawnOptions, options?: BunSpawnOptions): BunSubprocess;
	spawnSync(
		commandOrOptions: readonly string[] | BunSpawnOptions,
		options?: BunSpawnOptions,
	): { readonly exitCode: number | null };
	$: (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
}

function isCommand(value: readonly string[] | BunSpawnOptions): value is readonly string[] {
	return Array.isArray(value);
}

function splitArgs(
	commandOrOptions: readonly string[] | BunSpawnOptions,
	options: BunSpawnOptions | undefined,
): { cmd: readonly string[]; opts: BunSpawnOptions } {
	if (isCommand(commandOrOptions)) return { cmd: commandOrOptions, opts: options ?? {} };
	const { cmd = [], ...rest } = commandOrOptions;
	return { cmd, opts: rest };
}

/** Runs `fn` with the gated Bun launch globals passing straight through to the real ones. */
export type BunGateBypass = <T>(fn: () => T) => T;

/**
 * Gates the Bun launch globals and returns the bypass the gated `child_process` runs its real calls in: in Bun,
 * `node:child_process` launches through `Bun.spawn`, and that launch is already gated (ack, proof, record, shim) by
 * the outer call - gating it again would record it twice and wrap the command in a second go-line shim.
 */
export function installGatedBun(bun: BunLaunchGlobals, client: WorkerLaunchClient): BunGateBypass {
	const real = { spawn: bun.spawn.bind(bun), spawnSync: bun.spawnSync.bind(bun), $: bun.$ };
	const posix = process.platform !== "win32";
	let bypassDepth = 0;
	const bypass: BunGateBypass = (fn) => {
		bypassDepth += 1;
		try {
			return fn();
		} finally {
			bypassDepth -= 1;
		}
	};
	bun.spawn = (commandOrOptions, options) => {
		if (bypassDepth > 0) return real.spawn(commandOrOptions, options);
		const { cmd, opts } = splitArgs(commandOrOptions, options);
		if (!posix || opts.detached === false) {
			const launchId = client.acquire({
				origin: "kernel",
				api: "bun.spawn",
				containment: "inherited",
				lifetime: "owned",
			});
			client.invoke(launchId);
			const child = real.spawn([...cmd], withCurrentEnv(opts));
			void child.exited.then((exitCode) => client.done(launchId, { exitCode }));
			return child;
		}
		const program = cmd[0] ?? "";
		// A program Bun cannot find is refused here, before anything starts, exactly as an ungated Bun.spawn throws.
		const which: unknown = Reflect.get(bun, "which");
		const pathEnv = opts.env === undefined ? process.env.PATH : String(Reflect.get(Object(opts.env), "PATH") ?? "");
		if (
			typeof which === "function" &&
			Reflect.apply(which, bun, [program, { PATH: pathEnv, cwd: opts.cwd }]) === null
		)
			throw bunEnoentError(program);
		const callerStdio = bunStdio(opts);
		const fd = controlFd(callerStdio);
		const child = real.spawn(
			["/bin/sh", "-c", goShimScript(fd), ...cmd],
			withCurrentEnv({
				...opts,
				stdio: withControlPipe<unknown>(callerStdio, fd, "ignore", "pipe"),
				detached: true,
			}),
		);
		const launchId = client.acquire({
			origin: "kernel",
			api: "bun.spawn",
			containment: "own-group",
			lifetime: opts.detached === true ? "detached" : "owned",
			pid: child.pid,
			pgid: child.pid,
		});
		void child.exited.then((exitCode) => client.done(launchId, { exitCode }));
		client.invoke(launchId);
		const control: unknown = Reflect.get(Object(Reflect.get(child, "stdio")), fd);
		if (typeof control === "number") writeSync(control, "go\n");
		return child;
	};
	bun.spawnSync = (commandOrOptions, options) => {
		if (bypassDepth > 0) return real.spawnSync(commandOrOptions, options);
		const launchId = client.acquire({
			origin: "kernel",
			api: "bun.spawnSync",
			containment: "inherited",
			lifetime: "owned",
		});
		client.invoke(launchId);
		const { cmd, opts } = splitArgs(commandOrOptions, options);
		const result = real.spawnSync([...cmd], withCurrentEnv(opts));
		client.done(launchId, { exitCode: result.exitCode });
		return result;
	};
	bun.$ = (strings, ...values) => {
		if (bypassDepth > 0) return real.$(strings, ...values);
		const launchId = client.acquire({
			origin: "kernel",
			api: "bun.shell",
			containment: "inherited",
			lifetime: "owned",
		});
		client.invoke(launchId);
		const shell = real.$(strings, ...values);
		if (shell !== null && typeof shell === "object" && "then" in shell && typeof shell.then === "function") {
			void Promise.resolve(shell).then(
				(output: unknown) => client.done(launchId, { exitCode: exitCodeOf(output) }),
				(error: unknown) => client.done(launchId, { exitCode: exitCodeOf(error) ?? 1 }),
			);
		}
		return shell;
	};
	return bypass;
}

/**
 * The go-line shim reads its `go` from stdin, so stdin must be a pipe. In Bun a `stdio` array outranks a separate
 * `stdin` option: its first entry is replaced too. Returns the caller's own stdin choice, honoured after the go line.
 */
/** The caller's stdin, stdout and stderr as one array (a `stdio` array outranks the separate options, as in Bun). */
function bunStdio(opts: BunSpawnOptions): unknown[] {
	const stdio: unknown = opts.stdio;
	if (Array.isArray(stdio)) return [...stdio];
	return [opts.stdin ?? "ignore", Reflect.get(opts, "stdout") ?? "pipe", Reflect.get(opts, "stderr") ?? "inherit"];
}

/** The error an ungated Bun.spawn throws for a program it cannot find. */
function bunEnoentError(program: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`ENOENT: no such file or directory, posix_spawn '${program}'`), {
		errno: -2,
		code: "ENOENT",
		syscall: "posix_spawn",
		path: program,
	});
}

/**
 * Bun.spawn without an `env` hands the child the environment the process STARTED with, ignoring keys deleted from
 * `process.env` since (measured on Bun 1.4: a deleted key still reaches `Bun.spawnSync`, not `node:child_process` or
 * `Bun.$`). Passing the current `process.env` keeps every launch API equal: the tool child's scrubbed internals stay out.
 */
function withCurrentEnv(opts: BunSpawnOptions): BunSpawnOptions {
	return opts.env === undefined ? { ...opts, env: { ...process.env } } : opts;
}

function exitCodeOf(value: unknown): number | undefined {
	return value !== null && typeof value === "object" && "exitCode" in value && typeof value.exitCode === "number"
		? value.exitCode
		: undefined;
}
