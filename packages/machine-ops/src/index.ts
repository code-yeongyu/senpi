export { MachineOpError, opErrorCode } from "./errors.ts";
export {
	foldPathForCaseInsensitiveFilesystem,
	isMissingPathError,
	RESOLUTION_DEADLINE_MS,
	RESOLUTION_TIMED_OUT,
	withResolutionDeadline,
} from "./files/bounded-realpath.ts";
export { type FdResolver, globToRegExp } from "./files/glob.ts";
export {
	acquireFileMutationLock,
	FileLockedByStuckModuleError,
	type FileMutationLock,
	withFileMutationQueue,
	withFileMutationQueues,
} from "./files/mutation-queue.ts";
export { realpathWithoutOpen, realpathWithoutOpenStrict } from "./files/realpath-without-open.ts";
export { DEFAULT_LIMITS } from "./limits.ts";
export { createLocalMachineOps, type LocalMachineOpsOptions } from "./local.ts";
export {
	canonicalizeFilesystemPath,
	composeFilesystemPolicies,
	type FilesystemOperation,
	type FilesystemPolicy,
	type FilesystemPolicyChecker,
	type FilesystemPolicyDecision,
	type FilesystemPolicyRequest,
} from "./policy/filesystem.ts";
export { curatedEnv, defaultShell } from "./process/exec.ts";
export type { HeldExit, HeldTerminal, HolderLink, HolderSpawnRequest } from "./process/holder-link.ts";
export { RUNTIME_ENV, SCOPE_ENV, SWEEP_LADDER } from "./process/scopes.ts";
export { waitForChildProcess, type WaitForChildProcessOptions } from "./process/wait-child.ts";
export type * from "./types.ts";
