import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type BridgeConnectionConfig,
	decodeBridgeFrame,
	encodeBridgeFrame,
	type HostToKernelMessage,
	isKernelToHostMessage,
	type KernelToHostMessage,
} from "../../bridge/protocol.ts";
import {
	defaultSpawn,
	hardKill,
	type KernelChild,
	type KernelSpawnOptions,
	type KernelSpawnProcess,
	numberOrNull,
	signalOrNull,
	splitCommand,
	waitForExit,
	withTimeout,
} from "./process.ts";

export type PythonTransportResult = Extract<KernelToHostMessage, { type: "result" }>;

export interface PythonTransportRunInput {
	readonly cellId: string;
	readonly code: string;
	readonly timeoutMs?: number;
}

export interface PythonTransportOptions {
	readonly interpreterPath: string;
	readonly sessionId: string;
	readonly cwd: string;
	readonly connection: BridgeConnectionConfig;
	readonly env?: NodeJS.ProcessEnv;
	readonly startupTimeoutMs: number;
	readonly onMessage?: (message: KernelToHostMessage) => void;
	readonly spawnProcess?: KernelSpawnProcess;
	readonly isOwned: () => boolean;
	readonly onOwnershipFailure: (transport: PythonKernelTransport, error: Error) => Error;
	readonly onResult: (transport: PythonKernelTransport, result: PythonTransportResult) => void;
	readonly onExit: (transport: PythonKernelTransport, error: Error) => void;
}

const hardKillWaitMs = 500;

export class PythonKernelTransport {
	readonly #options: PythonTransportOptions;
	readonly #child: KernelChild;
	#stdoutBuffer = "";
	#stderrTail = "";
	#settleReady: ((error?: Error) => void) | null = null;
	#active = true;
	#exited = false;
	#retirement: Promise<void> | null = null;

	private constructor(options: PythonTransportOptions, child: KernelChild) {
		this.#options = options;
		this.#child = child;
	}

	static async start(options: PythonTransportOptions): Promise<PythonKernelTransport> {
		const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "prelude.py");
		const invocation = splitCommand(options.interpreterPath);
		const spawnOptions: KernelSpawnOptions = {
			command: invocation.command,
			args: [...invocation.args, "-u", scriptPath],
			cwd: options.cwd,
			env: { ...process.env, ...options.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
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
				if (retirementError instanceof Error) throw options.onOwnershipFailure(transport, retirementError);
				throw retirementError;
			}
			throw error;
		}
		return transport;
	}

	run(input: PythonTransportRunInput): void {
		this.#write({ type: "run", cellId: input.cellId, code: input.code, timeoutMs: input.timeoutMs });
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
		if (this.#exited) return;
		if (this.#retirement) {
			await this.#retirement;
			return;
		}
		if (!this.#active) {
			await hardKill(this.#child, hardKillWaitMs);
			return;
		}
		this.#active = false;
		const exited = waitForExit(this.#child, hardKillWaitMs);
		try {
			this.#write({ type: "close" });
		} catch (error) {
			if (!(error instanceof Error)) throw error;
		}
		if (!(await exited)) await hardKill(this.#child, hardKillWaitMs);
	}

	retire(): Promise<void> {
		if (this.#exited) return Promise.resolve();
		if (this.#retirement) return this.#retirement;
		this.#active = false;
		const retirement = hardKill(this.#child, hardKillWaitMs).finally(() => {
			if (this.#retirement === retirement) this.#retirement = null;
		});
		this.#retirement = retirement;
		return retirement;
	}

	async #initialize(): Promise<void> {
		const ready = new Promise<void>((resolve, reject) => {
			this.#settleReady = (error) => (error ? reject(error) : resolve());
		});
		this.#child.stdout.on("data", (chunk) => this.#onStdout(String(chunk)));
		this.#child.stderr.on("data", (chunk) => this.#onStderr(String(chunk)));
		this.#child.once("exit", (code, signal) => this.#onExit(numberOrNull(code), signalOrNull(signal)));
		this.#write({ type: "init", sessionId: this.#options.sessionId, connection: this.#options.connection });
		await withTimeout(ready, this.#options.startupTimeoutMs, "Python kernel did not become ready");
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
		if (message.type === "ready") this.#settleStartup();
		else if (message.type === "init-failed") this.#settleStartup(new Error(message.error.message));
		else if (message.type === "result") this.#options.onResult(this, message);
		this.#options.onMessage?.(message);
	}

	#onExit(code: number | null, signal: string | null): void {
		this.#exited = true;
		if (!this.#active) return;
		this.#active = false;
		const error = new Error(this.#stderrTail.trim() || `Python kernel exited (${code ?? signal ?? "unknown"})`);
		if (!this.#settleStartup(error)) this.#options.onExit(this, error);
	}

	#settleStartup(error?: Error): boolean {
		const settle = this.#settleReady;
		if (!settle) return false;
		this.#settleReady = null;
		settle(error);
		return true;
	}
}

export function failedPythonResult(cellId: string, message: string, stack?: string): PythonTransportResult {
	return { type: "result", cellId, ok: false, error: stack ? { message, stack } : { message }, durationMs: 0 };
}
