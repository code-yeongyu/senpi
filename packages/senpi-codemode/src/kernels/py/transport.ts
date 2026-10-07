import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KernelMemoryThresholds } from "../../bridge/memory-protocol.ts";
import {
	type BridgeConnectionConfig,
	decodeBridgeFrame,
	encodeBridgeFrame,
	type HostToKernelMessage,
	isKernelToHostMessage,
	type KernelToHostMessage,
} from "../../bridge/protocol.ts";
import { applySessionEnvironment, type SessionEnvironment } from "../session-env.ts";
import type { KernelPreludePlan } from "../shared/kernel-prelude-plan.ts";
import { readKernelCpuTime } from "../shared/process-cpu.ts";
import { type CodemodeRuntimeAssetEnvironment, requireCodemodeRuntimeAsset } from "../shared/runtime-asset.ts";
import {
	defaultSpawn,
	hardKill,
	type KernelChild,
	type KernelSpawnOptions,
	type KernelSpawnProcess,
	type KillProcessGroup,
	numberOrNull,
	signalOrNull,
	splitCommand,
	sweepProcessGroup,
	waitForExit,
} from "./process.ts";
import { PythonStartup, type PythonStartupStage } from "./startup.ts";

export type PythonTransportResult = Extract<KernelToHostMessage, { type: "result" }>;

export interface PythonTransportRunInput {
	readonly cellId: string;
	readonly code: string;
	readonly timeoutMs?: number;
	readonly preludePlan?: KernelPreludePlan;
	readonly envRoot?: () => string;
	readonly sourceFile?: string;
	readonly bridgeCellToken?: string;
}

export interface PythonTransportOptions {
	readonly interpreterPath: string;
	readonly sessionId: string;
	readonly cwd: string;
	readonly connection: BridgeConnectionConfig;
	readonly env?: NodeJS.ProcessEnv;
	/** Per-session PI_* values merged into the interpreter environment at spawn. */
	readonly sessionEnv?: SessionEnvironment;
	readonly startupTimeoutMs: number;
	readonly startupCeilingMs: number;
	readonly readCpuTime?: (pid: number | undefined) => bigint | undefined;
	readonly killProcessGroup?: KillProcessGroup;
	readonly onStartupProgress?: (stage: PythonStartupStage) => void;
	readonly memory?: KernelMemoryThresholds;
	/** Kernel-tool descriptors carry this; a restarted interpreter gets a new one, so old descriptors go stale. */
	readonly kernelGeneration?: number;
	readonly onMessage?: (message: KernelToHostMessage) => void;
	readonly spawnProcess?: KernelSpawnProcess;
	readonly isOwned: () => boolean;
	readonly onRetirementFailure: (transport: PythonKernelTransport, error: Error) => void;
	readonly onResult: (transport: PythonKernelTransport, result: PythonTransportResult) => void;
	readonly onError: (transport: PythonKernelTransport, error: Error) => void;
	readonly onExit: (
		transport: PythonKernelTransport,
		error: Error,
		exit: { readonly code: number | null; readonly signal: string | null },
	) => void;
}

const hardKillWaitMs = 500;

export interface PythonPreludePathOptions extends CodemodeRuntimeAssetEnvironment {
	readonly localPath?: string;
}

export function resolvePythonPreludePath(options: PythonPreludePathOptions = {}): string {
	return requireCodemodeRuntimeAsset(
		options.localPath ?? join(dirname(fileURLToPath(import.meta.url)), "prelude.py"),
		join("kernels", "py", "prelude.py"),
		options,
	);
}

export class PythonKernelTransport {
	readonly #options: PythonTransportOptions;
	readonly #child: KernelChild;
	#stdoutBuffer = "";
	#stderrTail = "";
	#startup: PythonStartup | null = null;
	#detachChildListeners: (() => void) | null = null;
	#active = true;
	#exited = false;
	#retirement: Promise<void> | null = null;
	#gone: Promise<void> | null = null;
	#isGone = false;

	private constructor(options: PythonTransportOptions, child: KernelChild) {
		this.#options = options;
		this.#child = child;
	}

	/**
	 * A retirement that timed out is confirmed only by this: the process really exited after all. The
	 * watch is attached on demand, so a transport nobody asks this of leaves no listener on its child.
	 */
	whenGone(): Promise<void> {
		if (this.#exited || this.#isGone) return Promise.resolve();
		this.#gone ??= new Promise<void>((resolve) => {
			this.#child.once("exit", () => {
				this.#isGone = true;
				resolve();
			});
		});
		return this.#gone;
	}

	static async start(options: PythonTransportOptions): Promise<PythonKernelTransport> {
		const scriptPath = resolvePythonPreludePath();
		const invocation = splitCommand(options.interpreterPath);
		const spawnOptions: KernelSpawnOptions = {
			command: invocation.command,
			args: [...invocation.args, "-u", scriptPath],
			cwd: options.cwd,
			env: {
				...applySessionEnvironment(process.env, options.sessionEnv),
				...options.env,
				PYTHONUNBUFFERED: "1",
				PYTHONIOENCODING: "utf-8",
			},
		};
		const child = (options.spawnProcess ?? defaultSpawn)(spawnOptions);
		const transport = new PythonKernelTransport(options, child);
		try {
			await transport.#initialize();
			if (!transport.#active) throw new Error("Python kernel exited during startup");
			if (!options.isOwned()) throw new Error("Python kernel startup was superseded");
		} catch (error) {
			try {
				await transport.retire();
			} catch (retirementError) {
				options.onRetirementFailure(
					transport,
					retirementError instanceof Error ? retirementError : new Error(String(retirementError)),
				);
			}
			throw error;
		}
		return transport;
	}

	/** Kernel-tool frames for the runner's control reader (served even while a cell runs). */
	post(message: HostToKernelMessage): void {
		if (this.#active && !this.#exited) this.#write(message);
	}

	run(input: PythonTransportRunInput): void {
		const preludes = input.preludePlan && {
			install: input.preludePlan.install.map(({ exports, python }) => ({ exports: [...exports], python })),
			remove: [...input.preludePlan.remove],
		};
		this.#write({
			type: "run",
			cellId: input.cellId,
			code: input.code,
			timeoutMs: input.timeoutMs,
			preludes,
			...(input.envRoot === undefined ? {} : { envRoot: input.envRoot() }),
			...(input.sourceFile === undefined ? {} : { sourceFile: input.sourceFile }),
			...(input.bridgeCellToken === undefined ? {} : { bridgeCellToken: input.bridgeCellToken }),
		});
	}

	interrupt(reason: string): void {
		try {
			this.#write({ type: "interrupt", reason });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#stderrTail = `${this.#stderrTail}Python interrupt frame write failed: ${message}\n`.slice(-4_000);
		}
		if (process.platform === "win32") this.#child.kill();
		else this.#child.kill("SIGINT");
	}

	async close(): Promise<void> {
		if (this.#exited || this.#isGone) return;
		if (this.#retirement) {
			await this.#retirement;
			return;
		}
		if (!this.#active) {
			await hardKill(this.#child, hardKillWaitMs, this.#options.killProcessGroup);
			return;
		}
		this.#active = false;
		const exited = waitForExit(this.#child, hardKillWaitMs);
		try {
			this.#write({ type: "close" });
		} catch (error) {
			if (!(error instanceof Error)) throw error;
		}
		// hardKill kills the whole group; a graceful leader exit does not, so sweep it
		// to retire any subprocess the cell left running in the kernel's process group.
		if (await exited) sweepProcessGroup(this.#child, this.#options.killProcessGroup);
		else await hardKill(this.#child, hardKillWaitMs, this.#options.killProcessGroup);
	}

	retire(): Promise<void> {
		if (this.#exited || this.#isGone) return Promise.resolve();
		if (this.#retirement) return this.#retirement;
		this.#active = false;
		const retirement = hardKill(this.#child, hardKillWaitMs, this.#options.killProcessGroup).finally(() => {
			this.#detachListeners();
			if (this.#retirement === retirement) this.#retirement = null;
		});
		this.#retirement = retirement;
		return retirement;
	}

	async #initialize(): Promise<void> {
		const pid = this.#child.pid;
		const startup = new PythonStartup({
			noProgressMs: this.#options.startupTimeoutMs,
			ceilingMs: this.#options.startupCeilingMs,
			failureDetail: () => this.#stderrTail,
			readCpuTime: () => {
				if (this.#options.readCpuTime) return this.#options.readCpuTime(pid);
				return pid === undefined ? undefined : readKernelCpuTime(pid);
			},
		});
		this.#startup = startup;
		const onStdout = (chunk: unknown) => this.#onStdout(String(chunk));
		const onStderr = (chunk: unknown) => this.#onStderr(String(chunk));
		const onError = (error: unknown) => this.#onError(error instanceof Error ? error : new Error(String(error)));
		const onExit = (code: unknown, signal: unknown) => this.#onExit(numberOrNull(code), signalOrNull(signal));
		this.#detachChildListeners = () => {
			this.#child.stdout.off("data", onStdout);
			this.#child.stderr.off("data", onStderr);
			this.#child.off("error", onError);
			this.#child.off("exit", onExit);
		};
		this.#child.stdout.on("data", onStdout);
		this.#child.stderr.on("data", onStderr);
		this.#child.on("error", onError);
		this.#child.on("exit", onExit);
		const { sessionId, connection, memory, kernelGeneration } = this.#options;
		this.#write({
			type: "init",
			sessionId,
			connection,
			...(memory === undefined ? {} : { memory }),
			...(kernelGeneration === undefined ? {} : { kernelGeneration }),
		});
		await startup.ready;
	}

	#write(message: HostToKernelMessage): void {
		this.#child.stdin.write(encodeBridgeFrame(message));
	}

	#onStdout(chunk: string): void {
		if (!this.#active) return;
		this.#stdoutBuffer += chunk;
		let newline = this.#stdoutBuffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.#stdoutBuffer.slice(0, newline + 1);
			this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
			this.#handleLine(line);
			newline = this.#stdoutBuffer.indexOf("\n");
		}
	}

	#onStderr(chunk: string): void {
		if (!this.#active) return;
		this.#startup?.activity();
		this.#stderrTail = `${this.#stderrTail}${chunk}`.slice(-4_000);
		this.#options.onMessage?.({ type: "text", stream: "stderr", data: chunk });
	}

	#handleLine(line: string): void {
		const decoded = decodeBridgeFrame(line);
		if (!decoded.ok) {
			this.#options.onMessage?.({ type: "text", stream: "stderr", data: `${decoded.error.message}\n` });
			return;
		}
		if (!isKernelToHostMessage(decoded.message)) return;
		const message = decoded.message;
		if (message.type === "status" && message.event.op === "kernel-startup") {
			const stage = this.#startup?.progress(message);
			if (stage !== undefined) this.#options.onStartupProgress?.(stage);
			return;
		}
		if (message.type === "text") this.#startup?.activity();
		if (message.type === "ready") this.#settleStartup();
		else if (message.type === "init-failed") this.#settleStartup(new Error(message.error.message));
		else if (message.type === "result") this.#options.onResult(this, message);
		this.#options.onMessage?.(message);
	}

	#onExit(code: number | null, signal: string | null): void {
		if (this.#exited) return;
		this.#exited = true;
		const active = this.#active;
		this.#active = false;
		const error = new Error(this.#stderrTail.trim() || `Python kernel exited (${code ?? signal ?? "unknown"})`);
		this.#detachListeners();
		if (!active) return;
		if (!this.#settleStartup(error)) this.#options.onExit(this, error, { code, signal });
	}

	#onError(error: Error): void {
		if (this.#exited || !this.#active) return;
		this.#active = false;
		if (!this.#settleStartup(error)) this.#options.onError(this, error);
	}

	#detachListeners(): void {
		const detach = this.#detachChildListeners;
		if (!detach) return;
		this.#detachChildListeners = null;
		detach();
		this.#stdoutBuffer = "";
		this.#stderrTail = "";
	}

	#settleStartup(error?: Error): boolean {
		return this.#startup?.settle(error) ?? false;
	}
}

export function failedPythonResult(cellId: string, message: string, stack?: string): PythonTransportResult {
	return { type: "result", cellId, ok: false, error: stack ? { message, stack } : { message }, durationMs: 0 };
}
