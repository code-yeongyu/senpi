/**
 * Launch the neo (Go-native) TUI as a child process and hand the terminal to it.
 *
 * The launcher resolves the platform binary, spawns it with inherited stdio so
 * the Go TUI owns the terminal directly, forwards the signals a TUI cares about
 * (SIGINT/SIGTERM/SIGWINCH), and propagates the child's exit code — or, if the
 * child died from a signal, re-raises that signal on this process so the parent
 * shell observes the same termination the classic path would produce.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { Args } from "../args.ts";
import { buildNeoArgv } from "./build-argv.ts";
import { resolveNeoBinary } from "./resolve-binary.ts";

/** Signals forwarded from the launcher to the neo child while it runs. */
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGWINCH"] as const;
type ForwardedSignal = (typeof FORWARDED_SIGNALS)[number];

export interface NeoLauncherDeps {
	/** Injectable for tests; defaults to node:child_process spawn. */
	readonly spawnFn?: typeof spawn;
	/** Injectable sink for the actionable resolution error; defaults to console.error. */
	readonly errorSink?: (message: string) => void;
}

/**
 * Resolve + spawn the neo binary. Resolves to the exit code the launcher process
 * should adopt. On a fatal resolution error, prints a single actionable message
 * (no stack) and resolves to 1 so the caller can exit cleanly.
 */
export async function runNeoLauncher(parsed: Args, deps: NeoLauncherDeps = {}): Promise<number> {
	const spawnFn = deps.spawnFn ?? spawn;
	const errorSink = deps.errorSink ?? ((message: string) => console.error(message));

	const resolution = resolveNeoBinary({ devBinPath: parsed.neoBin });
	if (!resolution.ok) {
		errorSink(resolution.message);
		return 1;
	}

	const argv = buildNeoArgv(parsed, { isolated: parsed.neoIsolated === true });
	const child = spawnFn(resolution.path, argv, { stdio: "inherit" });

	return await superviseNeoChild(child);
}

function superviseNeoChild(child: ChildProcess): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const forwarders = new Map<ForwardedSignal, () => void>();
		for (const signal of FORWARDED_SIGNALS) {
			const forward = () => {
				// Best-effort: the child may already be gone.
				child.kill(signal);
			};
			forwarders.set(signal, forward);
			process.on(signal, forward);
		}

		const cleanup = () => {
			for (const [signal, forward] of forwarders) {
				process.removeListener(signal, forward);
			}
		};

		child.on("error", (error) => {
			cleanup();
			reject(error);
		});

		child.on("close", (code, signal) => {
			cleanup();
			if (signal) {
				// Re-raise the child's terminating signal so the parent shell sees the
				// same cause of death. Node's default disposition then ends this process.
				process.kill(process.pid, signal);
				// If we're still alive (signal was intercepted), fall back to a code.
				resolve(1);
				return;
			}
			resolve(code ?? 1);
		});
	});
}
