import { runWithProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import { withoutOpenTiming } from "../../core/open-timing.ts";
import { outsideCommand } from "./command-authority.ts";
import { runSetThinkingLevel } from "./effect-commands.ts";
import { runSetModel } from "./handlers-model.ts";
import { runSetPermissionPreset } from "./permission-preset-command.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import type { OpenRpcSession, RpcSessionLaunchProfile } from "./session-registry.ts";
import { applyAttachedProfile } from "./session-registry-attach.ts";
import { releaseOwnedSession, releaseOwnerAttachment } from "./session-router-attachments.ts";
import { finalizeClose, tryClaimClose } from "./session-router-close.ts";
import type { RouterContext } from "./session-router-context.ts";
import { code, error } from "./session-router-errors.ts";
import { open } from "./session-router-open.ts";
import { validatedOpenProfile } from "./session-router-open-profile.ts";
import { holdOpenConnection, ownOpen, publishOpen, replyOpen } from "./session-router-open-result.ts";
import { syncRetainedRecord } from "./session-router-residency.ts";

type ParkCommand = Extract<RpcCommand, { type: "park_session" }>;
type ClaimCommand = Extract<RpcCommand, { type: "claim_session" }>;

function profileKey(profile: RpcSessionLaunchProfile): string {
	return JSON.stringify([
		profile.cwd,
		profile.sessionKind ?? "interactive",
		Object.entries(profile.sessionContext ?? {}).sort(([a], [b]) => a.localeCompare(b)),
	]);
}

/** Same open, host-context merge, kind, media and binding; no owner and no publication. */
async function buildPark(host: RouterContext, command: ParkCommand): Promise<OpenRpcSession> {
	let opened: OpenRpcSession | undefined;
	const response = await outsideCommand(() =>
		host.writer.connectionContext.outside(() =>
			withoutOpenTiming(() =>
				open(host, { ...command, type: "open_session", attended: false }, undefined, {
					reply: false,
					park: (result) => {
						opened = result;
					},
				}),
			),
		),
	);
	if (response && !response.success) throw new Error(response.error);
	if (!opened) throw new Error("park_open_failed");
	return opened;
}

/** Quiet teardown: speculation never owes a public terminal record or a handover park. */
export async function closePark(host: RouterContext, opened: OpenRpcSession): Promise<void> {
	const claim = tryClaimClose(host, opened.sessionId, { drainAttachments: true });
	if (claim?.finalizer) await finalizeClose(host, opened.sessionId, host.bindings.get(opened.sessionId));
	else await host.finalizations.get(opened.sessionId)?.promise;
	host.writer.forgetSession(opened.sessionId);
}

export async function parkSession(host: RouterContext, command: ParkCommand): Promise<RpcResponse> {
	if (!host.registry.supportsParkClaim) return error(command.id, command.type, "park_claim_unsupported");
	if (host.draining || host.drainExitRequested) return error(command.id, command.type, "host_draining");
	const profile = validatedOpenProfile(host, { ...command, type: "open_session" });
	if ("type" in profile) return { ...profile, command: command.type } as RpcResponse;
	try {
		const state = await host.parks.park(profileKey(profile), () => buildPark(host, command));
		if (host.draining || host.drainExitRequested) return error(command.id, command.type, "host_draining");
		return { id: command.id, type: "response", command: command.type, success: true, data: { state } };
	} catch (cause) {
		return error(command.id, command.type, code(cause));
	}
}

export function claimSession(host: RouterContext, command: ClaimCommand): Promise<RpcResponse | undefined> {
	const owner = host.writer.currentConnection();
	const release = owner === undefined ? undefined : holdOpenConnection(host, owner);
	return claimReady(host, command, owner).finally(release);
}

async function claimReady(
	host: RouterContext,
	command: ClaimCommand,
	owner: string | undefined,
): Promise<RpcResponse | undefined> {
	if (!host.registry.supportsParkClaim || !host.registry.claimPark)
		return error(command.id, command.type, "park_claim_unsupported");
	if (host.draining || host.drainExitRequested) return error(command.id, command.type, "host_draining");
	const miss = (): RpcResponse => ({
		id: command.id,
		type: "response",
		command: "claim_session",
		success: true,
		data: { claimed: false },
	});
	// These require construction or a distinct admission contract. A miss leaves the park untouched.
	if (
		command.sessionPath !== undefined ||
		command.durableSessionId !== undefined ||
		command.expectedHostInstance !== undefined ||
		command.admissionId !== undefined ||
		command.retry !== undefined ||
		(command.provider !== undefined) !== (command.modelId !== undefined) ||
		command.spawnedBy !== undefined ||
		command.env !== undefined ||
		command.auto_title !== undefined ||
		command.retryFallback !== undefined ||
		(owner !== undefined && host.writer.compactSelection(owner)?.selected)
	)
		return miss();
	const profile = validatedOpenProfile(host, { ...command, type: "open_session" });
	if ("type" in profile) return { ...profile, command: command.type } as RpcResponse;
	const key = profileKey(profile);
	const opened = host.parks.take(key);
	if (!opened) return miss();
	let success = false;
	try {
		const entry = host.registry.peek(opened.sessionId);
		if (entry?.state !== "open" || !entry.runtime) return miss();
		const runtime = entry.runtime;
		const ctx = { session: runtime.session, sessionId: opened.sessionId, by: { connectionId: owner ?? "host" } };
		await runWithProviderScope(entry.scope, async () => {
			const responses: RpcResponse[] = [];
			if (command.provider !== undefined && command.modelId !== undefined)
				responses.push(
					await runSetModel(ctx, {
						type: "set_model",
						provider: command.provider,
						modelId: command.modelId,
						scope: "session",
					}),
				);
			if (command.thinkingLevel !== undefined)
				responses.push(
					await runSetThinkingLevel(ctx, {
						type: "set_thinking_level",
						level: command.thinkingLevel,
						scope: "turn",
					}),
				);
			if (command.permissionPreset !== undefined)
				responses.push(
					runSetPermissionPreset(runtime, {
						type: "set_permission_preset",
						permissionPreset: command.permissionPreset,
					}),
				);
			const refused = responses.find((response) => !response.success);
			if (refused && !refused.success) throw new Error(refused.error);
			applyAttachedProfile(entry, { ...profile, permissionPreset: undefined, permissionPresetSource: undefined });
			if (runtime.launchProfile) entry.profile = runtime.launchProfile;
		});
		if (host.draining || host.drainExitRequested || (owner !== undefined && host.releasedConnections.has(owner)))
			return miss();
		const claimed = await host.registry.claimPark(opened.sessionId, command.retain_on_disconnect === true);
		if (host.draining || host.drainExitRequested) return miss();
		entry.acceptance?.applyTranscript(runtime.session.sessionManager.drainTranscript());
		ownOpen(host, claimed, owner);
		host.bindings
			.get(claimed.sessionId)
			?.setClientCapabilities?.(
				(owner === undefined ? undefined : host.pendingCapabilities.get(owner)) ??
					host.connectionOptions?.capabilities ??
					[],
			);
		publishOpen(host, claimed, entry);
		await syncRetainedRecord(host, claimed.sessionId, undefined);
		replyOpen(host, claimed, entry, command);
		success = true;
		if (owner !== undefined && host.releasedConnections.has(owner)) {
			releaseOwnerAttachment(host, owner, claimed.sessionId);
			await releaseOwnedSession(host, claimed.sessionId);
		}
		return undefined;
	} catch (cause) {
		return error(command.id, command.type, code(cause));
	} finally {
		if (!success) await closePark(host, opened);
		host.parks.finish(key);
		if (success) {
			const replacement: ParkCommand = {
				type: "park_session",
				cwd: command.cwd,
				kind: command.kind,
				context: command.context,
			};
			host.parks.replace(key, () => buildPark(host, replacement));
		}
	}
}
