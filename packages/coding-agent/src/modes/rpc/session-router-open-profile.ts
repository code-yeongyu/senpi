import { isSpawnedBy } from "../../core/session-spawned-by.ts";
import { HOST_DAEMON_DIR_ENV } from "./host-daemon-paths.ts";

import { hostInstanceId } from "./protocol-identity.ts";
import {
	sessionAutoTitleError,
	sessionBrowserEngineError,
	sessionContextError,
	sessionKindError,
	sessionPromptSurfaceError,
	sessionRetryFallbackError,
} from "./rpc-input-validation.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import {
	RPC_ERROR_INVALID_LAUNCH_PROFILE,
	RPC_ERROR_INVALID_SESSION_CONTEXT,
	RPC_ERROR_INVALID_SESSION_ENV,
	RPC_ERROR_INVALID_SESSION_KIND,
	RPC_ERROR_OWNER_CHANGED,
} from "./rpc-types.ts";
import { inheritedSessionEnv, type SessionEnv, sessionEnvError } from "./session-caller-env.ts";

import type { RpcSessionLaunchProfile } from "./session-registry.ts";

import type { RouterContext } from "./session-router-context.ts";

import { error } from "./session-router-errors.ts";
/** `open_session.spawnedBy` must name the parent, root and task when present; the open answers `invalid_spawned_by` otherwise. */
export function invalidSpawnedBy(command: Extract<RpcCommand, { type: "open_session" }>): boolean {
	const ancestry = command.spawnedBy;
	return ancestry !== undefined && !isSpawnedBy(ancestry);
}

export function validatedOpenProfile(
	host: RouterContext,
	command: Extract<RpcCommand, { type: "open_session" }>,
	options?: { readonly defaults?: boolean },
): RpcSessionLaunchProfile | RpcResponse {
	// A parked session's reopen replays what its park recorded; a field it left empty stays empty
	// rather than taking THIS host's default (senpi#3376 review).
	const defaults = options?.defaults === false ? undefined : host.defaults;
	const instanceId = host.defaults.hostContext?.host_instance ?? hostInstanceId();
	if (command.expectedHostInstance !== undefined) {
		if (typeof command.expectedHostInstance !== "string" || command.expectedHostInstance.trim() === "")
			return error(
				command.id,
				"open_session",
				`${RPC_ERROR_INVALID_LAUNCH_PROFILE}: expectedHostInstance must be a non-empty string`,
				{
					reason: "invalid_expected_host_instance",
					action: "supply_host_instance",
				},
			);
		if (command.expectedHostInstance !== instanceId)
			return error(command.id, "open_session", RPC_ERROR_OWNER_CHANGED, {
				reason: "host_instance_mismatch",
				action: "rediscover_holder",
				expectedHostInstance: command.expectedHostInstance,
				hostInstance: instanceId,
			});
	}
	// The opaque per-session inputs are parsed HERE, at the wire boundary, so the
	// registry, the runtime and the extensions downstream receive values already
	// proven to satisfy every documented cap.
	const kindError = sessionKindError(command.kind);
	if (command.attended !== undefined && command.attended !== false)
		return error(
			command.id,
			"open_session",
			`${RPC_ERROR_INVALID_LAUNCH_PROFILE}: attended must be false or omitted`,
		);
	if (kindError) return error(command.id, "open_session", `${RPC_ERROR_INVALID_SESSION_KIND}: ${kindError}`);
	const contextError = sessionContextError(command.context);
	if (contextError) return error(command.id, "open_session", `${RPC_ERROR_INVALID_SESSION_CONTEXT}: ${contextError}`);
	const autoTitleError = sessionAutoTitleError(command.auto_title);
	if (autoTitleError)
		return error(command.id, "open_session", `${RPC_ERROR_INVALID_LAUNCH_PROFILE}: ${autoTitleError}`);
	const promptSurfaceError = sessionPromptSurfaceError(command.promptSurface);
	if (promptSurfaceError)
		return error(command.id, "open_session", `${RPC_ERROR_INVALID_LAUNCH_PROFILE}: ${promptSurfaceError}`);
	const browserEngineError = sessionBrowserEngineError(command.browserEngine);
	if (browserEngineError)
		return error(command.id, "open_session", `${RPC_ERROR_INVALID_LAUNCH_PROFILE}: ${browserEngineError}`);
	if (!command.provider !== !command.modelId)
		return error(
			command.id,
			"open_session",
			`${RPC_ERROR_INVALID_LAUNCH_PROFILE}: provider and modelId must be given together`,
		);
	const retryFallbackError = sessionRetryFallbackError(command.retryFallback);
	if (retryFallbackError)
		return error(command.id, "open_session", `${RPC_ERROR_INVALID_LAUNCH_PROFILE}: ${retryFallbackError}`);
	const envError = sessionEnvError(command.env);
	if (envError) return error(command.id, "open_session", `${RPC_ERROR_INVALID_SESSION_ENV}: ${envError}`);
	const sessionEnv = inheritedSessionEnv(parentSessionEnv(host, command.spawnedBy?.parentSessionId), command.env);
	return {
		cwd: command.cwd ?? host.defaults.cwd,
		...(command.attended === false ? { attended: false as const } : {}),
		sessionPath: command.sessionPath,
		holderEndpoint: {
			host_instance: instanceId,
			...(process.env[HOST_DAEMON_DIR_ENV] ? { host_daemon_dir: process.env[HOST_DAEMON_DIR_ENV] } : {}),
			...(host.defaults.hostContext?.host_socket === undefined
				? {}
				: { host_socket: host.defaults.hostContext.host_socket }),
		},
		permissionPreset: command.permissionPreset ?? defaults?.permissionPreset,
		creationModel:
			command.provider && command.modelId
				? { provider: command.provider, modelId: command.modelId }
				: defaults?.creationModel,
		initialThinkingLevel: command.thinkingLevel ?? defaults?.initialThinkingLevel,
		sessionKind: command.kind,
		sessionContext: host.defaults.hostContext
			? { ...command.context, ...host.defaults.hostContext }
			: command.context,
		...(command.durableSessionId !== undefined ? { durableSessionId: command.durableSessionId } : {}),
		...(typeof command.auto_title === "boolean" ? { autoTitle: command.auto_title } : {}),
		...(command.promptSurface !== undefined ? { promptSurface: command.promptSurface } : {}),
		...(command.browserEngine !== undefined ? { browserEngine: command.browserEngine } : {}),
		...(command.retryFallback !== undefined ? { retryFallback: command.retryFallback } : {}),
		...(sessionEnv !== undefined ? { sessionEnv } : {}),
	};
}

/**
 * The caller env of a task child's parent, when THIS host currently holds that parent (senpi#4381): a lane
 * identity follows the task tree without every opener repeating it. A closed parent or one elsewhere
 * contributes nothing. The opening connection is not tied to the parent: this is the attach trust boundary,
 * since any client that names an open session can already attach to it and run its tools. A parent counts
 * exactly when attach would accept it (open and bound); a closing or quarantined one contributes nothing.
 */
function parentSessionEnv(host: RouterContext, parentSessionId: string | undefined): SessionEnv | undefined {
	if (parentSessionId === undefined) return undefined;
	const parent = host.registry
		.list()
		.find((row) => row.durableSessionId === parentSessionId || row.sessionId === parentSessionId);
	if (parent === undefined) return undefined;
	const entry = host.registry.peek(parent.sessionId);
	return entry?.state === "open" && host.bindings.has(parent.sessionId) ? entry.profile.sessionEnv : undefined;
}
