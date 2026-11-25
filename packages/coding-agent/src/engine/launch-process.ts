import { type ChildProcess, type SpawnOptions, spawn, type StdioOptions } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { LAUNCH_KEY_CHANNEL } from "../cli/launch-key.ts";
import { isBunBinary } from "../config.ts";
import { resolveCliMainPath } from "../modes/rpc/host-cli-entry.ts";
import { PRIVATE_FDS_FINAL_ENV } from "../private-fds.ts";
import { PRIVATE_FDS_TABLE_ENV } from "../private-fd-table.ts";
import { runtimeExecArgv } from "../utils/runtime-exec-argv.ts";
import type { LaunchKeyHandle } from "./launch-options.ts";

/** The descriptor the launched engine reads its key from: inside the range it adopts (`ADOPTABLE_MAX`). */
export const LAUNCH_KEY_FD = 5;
const PRESENTER_FD = 4;

/** Every external dependency of a launch, replaced by tests. */
export interface LaunchPorts {
	readonly spawn: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
	/** The engine entry: the compiled binary, or the runtime with its CLI module. */
	readonly engine: () => { readonly command: string; readonly args: readonly string[] };
	readonly env: () => NodeJS.ProcessEnv;
	readonly agentDir: () => string;
}

export function defaultLaunchPorts(agentDir: () => string): LaunchPorts {
	return {
		spawn,
		engine: () => ({
			command: process.execPath,
			args: isBunBinary ? [] : [...runtimeExecArgv(), resolveCliMainPath()],
		}),
		env: () => process.env,
		agentDir,
	};
}

export interface StartedEngine {
	readonly child: ChildProcess;
	readonly exited: Promise<{ readonly exit_code: number | null }>;
}

function slots(base: StdioOptions, extra: Readonly<Record<number, "pipe" | number>>): StdioOptions {
	const stdio = typeof base === "string" ? [base, base, base] : [...base];
	for (const [fd, slot] of Object.entries(extra)) {
		while (stdio.length <= Number(fd)) stdio.push("ignore");
		stdio[Number(fd)] = slot;
	}
	return stdio;
}

function deliverKey(child: ChildProcess, key: LaunchKeyHandle): void {
	const sink: unknown = Reflect.get(child.stdio, LAUNCH_KEY_FD);
	if (!(sink instanceof Writable)) return;
	const source = key instanceof Readable ? key : webChunks(key);
	pipeline(source, sink).catch(() => sink.destroy());
}

async function* webChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
	const reader = stream.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			yield value;
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * Starts the engine with `argv`. The environment never carries the key: a key travels on its own descriptor,
 * named in a private table built here, and this process forwards none of its own private channels.
 */
export function startEngine(
	ports: LaunchPorts,
	argv: readonly string[],
	stdio: StdioOptions,
	extras: { readonly key?: LaunchKeyHandle; readonly presenter?: boolean },
): Promise<StartedEngine | Error> {
	const env = { ...ports.env() };
	delete env[PRIVATE_FDS_TABLE_ENV];
	delete env[PRIVATE_FDS_FINAL_ENV];
	const extra: Record<number, "pipe" | number> = {};
	if (extras.presenter === true) extra[PRESENTER_FD] = PRESENTER_FD;
	if (extras.key !== undefined) {
		extra[LAUNCH_KEY_FD] = "pipe";
		env[PRIVATE_FDS_TABLE_ENV] = JSON.stringify({ [LAUNCH_KEY_CHANNEL]: LAUNCH_KEY_FD });
	}
	const entry = ports.engine();
	return new Promise((resolve) => {
		let child: ChildProcess;
		try {
			child = ports.spawn(entry.command, [...entry.args, ...argv], { env, stdio: slots(stdio, extra) });
		} catch (error: unknown) {
			resolve(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		const exited = new Promise<{ readonly exit_code: number | null }>((done) => {
			child.once("close", (code) => done({ exit_code: code }));
		});
		child.once("error", (error) => resolve(error));
		child.once("spawn", () => {
			if (extras.key !== undefined) deliverKey(child, extras.key);
			resolve({ child, exited });
		});
	});
}
