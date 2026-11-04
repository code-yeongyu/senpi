/**
 * The seam between the operation layer and whatever owns PTYs. The design's target is a separate holder process
 * that outlives the runtime (programs survive a runtime restart); this package ships only the interface and an
 * in-process link (`./in-process-holder`), whose terminals end with the process that created them.
 */
export interface HolderSpawnRequest {
	readonly id: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly cols: number;
	readonly rows: number;
}

export interface HeldExit {
	readonly exitCode: number | null;
	readonly signal: string | null;
}

export interface HeldTerminal {
	readonly id: string;
	readonly pid: number;
	/** Every output chunk, in order. Returns the unsubscribe. */
	onData(listener: (chunk: Uint8Array) => void): () => void;
	/** Called once with the exit; immediately (async) when the terminal already exited. */
	onExit(listener: (exit: HeldExit) => void): () => void;
	write(bytes: Uint8Array): void;
	resize(cols: number, rows: number): void;
	signal(signal: NodeJS.Signals): void;
	/** The rendered screen (visible grid plus up to `history` scrollback lines), when the holder emulates one. */
	screen?(history?: number): Promise<string>;
}

export interface HolderLink {
	spawn(req: HolderSpawnRequest): Promise<HeldTerminal>;
	close(): Promise<void>;
}
