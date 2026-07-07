import { loadNativePty, type NativePtyLoadResult } from "./native-loader.ts";
import { TerminalSession as BaseTerminalSession, type TerminalSessionOptions } from "./session.ts";

export type {
	NativePtyBinding,
	NativePtyLoadResult,
	NativePtyUnavailableDiagnostic,
} from "./native-loader.ts";
export {
	detectNativePtyRuntime,
	getNativePtyCandidatePaths,
	getNativePtyHost,
	type NativePtyRuntime,
	NativePtySentinelMismatchError,
} from "./native-loader.ts";
export {
	type InitialSessionRegistryEntry,
	isTerminalSessionExited,
	SessionRegistry,
	SessionRegistryCapacityError,
	type SessionRegistryCreateContext,
	type SessionRegistryCreateOptions,
	type SessionRegistryEntry,
	type SessionRegistryOptions,
	type SessionRegistrySession,
	type SessionRegistrySweepOptions,
	sessionIdPrefix,
	type TerminalSessionSignal,
	type TerminalSessionState,
	type TrackedDetachedChild,
} from "./registry.ts";
export { TerminalScreen, type TerminalScreenOptions, type TerminalScreenSnapshot } from "./screen.ts";
export {
	type CreateNativeTerminalSession,
	createTerminalSession,
	TerminalSession,
	type TerminalSessionBackend,
	type TerminalSessionDataHandler,
	type TerminalSessionDependencies,
	type TerminalSessionExit,
	type TerminalSessionExitError,
	type TerminalSessionExitState,
	type TerminalSessionHandle,
	type TerminalSessionNativeOptions,
	type TerminalSessionOperationResult,
	type TerminalSessionOptions,
} from "./session.ts";

export type PtySessionOptions = TerminalSessionOptions;

export class PtySession extends BaseTerminalSession {}

export function loadPtyNative(): NativePtyLoadResult {
	return loadNativePty();
}
