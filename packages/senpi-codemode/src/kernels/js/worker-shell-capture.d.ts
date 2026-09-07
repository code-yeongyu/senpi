export type ShellCaptureStream = "stdout" | "stderr";

export type ShellCaptureRestore = () => void;

export interface ShellCaptureChild {
	readonly exitCode: number | null;
	readonly signalCode: string | null;
	readonly exited: Promise<number>;
	kill(): void;
}

export interface ShellCaptureOptions {
	readonly isActive: () => boolean;
	readonly emitText: (stream: ShellCaptureStream, data: string) => void;
	/** Receives every `Bun.spawn` child created while a cell is active so the runtime can kill it on interrupt. */
	readonly onChild?: (child: ShellCaptureChild) => void;
}

export function installShellCapture(options: ShellCaptureOptions): ShellCaptureRestore;

declare global {
	/**
	 * Set by the JS worker core when applying the session environment deleted inherited
	 * `PI_*` keys (see worker-core.js). Under Bun a `delete process.env.X` does not
	 * unsetenv, so shell capture pins the worker's environment view for spawned children
	 * while this list is non-empty.
	 */
	var __senpi_session_env_deletions__: string[] | undefined;
	/**
	 * Set by the JS worker core once a session environment was applied (values set or inherited
	 * keys deleted). Bun.spawn without an explicit env inherits the OS environ rather than the
	 * worker's process.env, so shell capture pins the worker's view whenever this is true.
	 */
	var __senpi_session_env_applied__: boolean | undefined;
}
