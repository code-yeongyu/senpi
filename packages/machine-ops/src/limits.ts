import type { Limits } from "./types.ts";

const MIB = 1024 * 1024;

/** Machine-path defaults: herdr exec caps, bunshin read cap and shell budget, no PTY cap. */
export const DEFAULT_LIMITS: Limits = {
	readMaxBytes: 10 * MIB,
	execStdoutMaxBytes: 8 * MIB,
	execStderrMaxBytes: MIB,
	execTimeoutDefaultMs: 3_600_000,
	ptyScrollbackBytes: 2 * MIB,
	retainedOutputBytes: MIB,
};
