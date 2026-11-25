/**
 * The five launch operations (design 6.9). Each answers every refusal the command line has before anything
 * starts, then starts the engine entry as a new process with the argv the same options produce.
 */
import type { Readable, Writable } from "node:stream";
import { handSocketPath } from "../modes/hand/hand-entry.ts";
import { headlessSocketPath } from "../modes/headless/headless-host.ts";
import type {
	LaunchHandOptions,
	LaunchHeadlessOptions,
	LaunchInteractiveOptions,
	LaunchMode,
	LaunchOptions,
	LaunchPrintOptions,
	LaunchRpcOptions,
} from "./launch-options.ts";
import { type LaunchCode, prepareLaunch } from "./launch-prepare.ts";
import { type LaunchPrintRun, printRun } from "./launch-print-stream.ts";
import { type EngineExit, type LaunchPorts, type StartedEngine, startEngine } from "./launch-process.ts";
import { type EngineResult, engineError, engineOk } from "./result.ts";

export type { LaunchCode } from "./launch-prepare.ts";

export interface LaunchExit {
	readonly exit_code: number | null;
	/** The session the caller named; absent when none was named or the run was ephemeral. */
	readonly session?: string;
}

/** A launched engine that keeps running: its pid, its exit, and a stop that ends it. */
export interface LaunchedEngine {
	readonly pid: number | undefined;
	readonly exited: Promise<EngineExit>;
	stop(): Promise<EngineExit>;
}

export type LaunchRpcAnswer = LaunchedEngine &
	(
		| { readonly address: string }
		| { readonly stdio: { readonly input: Writable | null; readonly output: Readable | null } }
	);

export type LaunchSocketAnswer = LaunchedEngine & { readonly socket: string };

type LaunchStdio = "inherit" | ["ignore" | "inherit" | "pipe", "pipe" | "ignore", "inherit"];

/** Every refusal first; the stdio is chosen only from options that passed them. */
async function started(
	ports: LaunchPorts,
	mode: LaunchMode,
	options: LaunchOptions,
	stdio: (admitted: LaunchOptions) => LaunchStdio,
): Promise<EngineResult<StartedEngine, LaunchCode>> {
	const prepared = prepareLaunch(mode, options);
	if ("kind" in prepared) return prepared;
	const engine = await startEngine(ports, prepared.argv, stdio(options), {
		...(options.api_key === undefined ? {} : { key: options.api_key }),
		presenter: options.presenter !== undefined,
	});
	return engine instanceof Error ? engineError("launch_failed", engine.message) : engineOk(engine);
}

function running(engine: StartedEngine): LaunchedEngine {
	return {
		pid: engine.child.pid,
		exited: engine.exited,
		stop: () => {
			engine.child.kill("SIGTERM");
			return engine.exited;
		},
	};
}

function namedSession(options: LaunchOptions): string | undefined {
	return options.session?.ephemeral === true ? undefined : (options.session?.id ?? options.attach?.session);
}

export async function launchInteractive(
	ports: LaunchPorts,
	options: LaunchInteractiveOptions,
): Promise<EngineResult<LaunchExit, LaunchCode>> {
	const engine = await started(ports, "interactive", options, () => "inherit");
	if (engine.kind === "error") return engine;
	const { exit_code, failure } = await engine.value.exited;
	if (failure === "launch_key_failed") {
		return engineError("launch_key_failed", "the engine refused its launch key and did not start");
	}
	const session = namedSession(options);
	return engineOk({ exit_code, ...(session === undefined ? {} : { session }) });
}

export async function launchPrint(
	ports: LaunchPorts,
	options: LaunchPrintOptions,
): Promise<EngineResult<LaunchPrintRun, LaunchCode>> {
	const engine = await started(ports, "print", options, (admitted) => [
		admitted.input?.stdin === true ? "inherit" : "ignore",
		"pipe",
		"inherit",
	]);
	if (engine.kind === "error") return engine;
	const named = namedSession(options);
	return engineOk(
		printRun(engine.value.child, engine.value.exited, {
			json: options.mode === "json",
			ephemeral: options.session?.ephemeral === true,
			...(named === undefined ? {} : { named }),
		}),
	);
}

export async function launchRpc(
	ports: LaunchPorts,
	options: LaunchRpcOptions,
): Promise<EngineResult<LaunchRpcAnswer, LaunchCode>> {
	const listensOn = (admitted: LaunchOptions) => admitted.listen !== undefined && admitted.listen !== "stdio://";
	const engine = await started(ports, "rpc", options, (admitted) =>
		listensOn(admitted) ? ["ignore", "ignore", "inherit"] : ["pipe", "pipe", "inherit"],
	);
	if (engine.kind === "error") return engine;
	const listening = listensOn(options);
	const { child } = engine.value;
	return engineOk(
		listening && options.listen !== undefined
			? { ...running(engine.value), address: options.listen }
			: { ...running(engine.value), stdio: { input: child.stdin, output: child.stdout } },
	);
}

export async function launchHand(
	ports: LaunchPorts,
	options: LaunchHandOptions,
): Promise<EngineResult<LaunchSocketAnswer, LaunchCode>> {
	const engine = await started(ports, "hand", options, () => ["ignore", "ignore", "inherit"]);
	if (engine.kind === "error") return engine;
	return engineOk({ ...running(engine.value), socket: handSocketPath(ports.agentDir()) });
}

export async function launchHeadless(
	ports: LaunchPorts,
	options: LaunchHeadlessOptions,
): Promise<EngineResult<LaunchSocketAnswer, LaunchCode>> {
	const engine = await started(ports, "headless", options, () => ["ignore", "ignore", "inherit"]);
	if (engine.kind === "error") return engine;
	return engineOk({ ...running(engine.value), socket: options.listen ?? headlessSocketPath(ports.agentDir()) });
}
