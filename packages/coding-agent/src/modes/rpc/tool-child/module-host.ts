/**
 * The host a registered child module's export receives as its second argument (senpi#3566 todo 8). It is the same
 * object on both runtimes: only `send` differs - the tool child's worker posts each call to the reverse bridge, the
 * in-process path hands it straight to the session's host-call handler - so a module behaves the same wherever the
 * session places it.
 */
import type { HostCallKind } from "./protocol.ts";

export type ModuleHostSend = (kind: HostCallKind, name: string | undefined, args: unknown) => Promise<unknown>;

export interface ModuleHost {
	/** Aborts when the job is cancelled. */
	readonly signal: AbortSignal;
	/** Runs a session tool on the server (hooks once), like `ctx.executeTool`. */
	call(name: string, args: unknown): Promise<unknown>;
	/** A model completion through the session's runtime. */
	complete(args: unknown): Promise<unknown>;
	/** A reserved tool, run server-side. */
	reserved(name: string, args: unknown): Promise<unknown>;
	/** The tools callable through `call`. */
	listTools(): Promise<unknown>;
	/**
	 * The session's filesystem policy decision for one access (never cached; ask before each). The server resolves `path`
	 * against the session cwd and canonicalizes it the way the built-in file tools do.
	 */
	authorize(request: {
		operation: "read" | "enumerate" | "write";
		path: string;
		toolName: string;
	}): Promise<{ allow: true } | { allow: false; reason: string }>;
	/**
	 * Runs `fn` holding the file's slot in the session's mutation queue - the same one its own file tools use - and
	 * releases it once `fn` settles. A cancel does not release it early: the slot passes on only after `fn` is done.
	 * Inside `fn`, never `call` a session tool that edits or writes the same file: it waits for this very slot and
	 * the job deadlocks until its deadline.
	 */
	withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T>;
}

export function createModuleHost(signal: AbortSignal, send: ModuleHostSend): ModuleHost {
	return {
		signal,
		call: (name, args) => send("tool", name, args),
		complete: (args) => send("completion", undefined, args),
		reserved: (name, args) => send("reserved", name, args),
		listTools: () => send("list_tools", undefined, undefined),
		authorize: (request) => send("authorize", undefined, request) as ReturnType<ModuleHost["authorize"]>,
		withFileLock: async (path, fn) => {
			const { lockId } = (await send("lock_file", undefined, { path })) as { lockId: string };
			try {
				return await fn();
			} finally {
				await send("unlock_file", undefined, { lockId });
			}
		},
	};
}
