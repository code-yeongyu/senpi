import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageDiagnostic,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { getSessionClaudeAccountPin } from "./account-command.ts";
import { queryWithAuthLane } from "./auth-lane.ts";
import { buildCustomToolServers } from "./custom-tools.ts";
import { defaultExecutableDeps, resolveClaudeCodeExecutable } from "./executable.ts";
import { buildClaudeSdkOauthQueryOptions } from "./options.ts";
import { buildPromptBlocks, buildPromptStream } from "./prompt-bridge.ts";
import { getSdkBoundary, type SdkQueryHandle } from "./sdk-boundary.ts";
import { type ContinuityObservation, emitContinuityObservation } from "./session-observability.ts";
import { residentSessionMessages } from "./session-stream.ts";
import { loadClaudeSdkOauthProviderSettingsFromDisk } from "./settings.ts";
import { applyStreamEvent } from "./stream-events.ts";
import { withAuthGuidance } from "./stream-guidance.ts";
import { emptyOutput, errorMessage, mapStopReason, type StreamBlock, updateUsage } from "./stream-protocol.ts";
import { toolWatch } from "./tool-watch.ts";
import { resolveSdkTools } from "./tools.ts";

export function streamClaudeSdkOauth(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void (async () => {
		const output = emptyOutput(model);
		const blocks: StreamBlock[] = [];
		let sdkQuery: SdkQueryHandle | undefined;
		let closed = false;
		let wasAborted = false;
		let started = false;
		let sawStreamEvent = false;
		const closeQuery = (): void => {
			if (closed || !sdkQuery) return;
			closed = true;
			sdkQuery.close();
		};
		const requestAbort = (): void => {
			if (!sdkQuery) return;
			void sdkQuery
				.interrupt()
				.catch(() => {})
				.finally(closeQuery);
		};
		const onAbort = (): void => {
			wasAborted = true;
			requestAbort();
		};
		if (options?.signal?.aborted) onAbort();
		else options?.signal?.addEventListener("abort", onAbort, { once: true });

		try {
			const resolvedTools = resolveSdkTools(context);
			const affinityKey = options?.affinitySessionId ?? options?.sessionId;
			const sessionKey = options?.sessionId ? toolWatch.sessionKey(options.sessionId) : undefined;
			if (sessionKey) toolWatch.reconcileWithContext(sessionKey, context);
			const toolWatchNote = toolWatch.buildPromptNote(sessionKey, context, resolvedTools.customToolNameToSdk);
			const providerSettings = loadClaudeSdkOauthProviderSettingsFromDisk(process.cwd());
			const mcpServers = buildCustomToolServers(resolvedTools.customTools);
			const executable = resolveClaudeCodeExecutable(defaultExecutableDeps());
			const buildOptions = (authLane: Parameters<typeof buildClaudeSdkOauthQueryOptions>[0]["authLane"]) => {
				const queryOptions = buildClaudeSdkOauthQueryOptions({
					model,
					context,
					streamOptions: options,
					providerSettings,
					authLane,
					tools: resolvedTools.sdkTools,
					pathToClaudeCodeExecutable: executable,
					sessionId: options?.sessionId,
					onGuidance: (text) => {
						output.diagnostics = [
							...(output.diagnostics ?? []),
							createAssistantMessageDiagnostic("claude_sdk_oauth_deprecation", text),
						];
					},
				});
				if (mcpServers) queryOptions.mcpServers = mcpServers;
				return queryOptions;
			};
			const recordContinuity = (observation: ContinuityObservation): void => {
				// Not a failure: carry the observation as details only, with no synthesized error.
				output.diagnostics = [
					...(output.diagnostics ?? []),
					{
						type: "claude_sdk_oauth_session_continuity",
						timestamp: Date.now(),
						details: { ...observation },
					},
				];
			};
			const useResidentSession =
				options?.streamKind === "main" && providerSettings.resumeMode !== "off" && options.sessionId !== undefined;
			if (options?.streamKind === "main" && !useResidentSession) {
				// The reason must reflect the ACTUAL cause: resume mode "off"
				// disables the lane by setting, while any other mode simply has no
				// resident session to reuse yet.
				emitContinuityObservation(
					{
						kind: "disabled",
						reason: providerSettings.resumeMode === "off" ? "resume_mode_off" : "registry_miss",
					},
					recordContinuity,
				);
			}
			const messages = useResidentSession
				? residentSessionMessages({
						model,
						context,
						streamOptions: options,
						providerSettings,
						pinnedAccount: getSessionClaudeAccountPin(options.sessionId),
						buildOptions,
						customToolNameToSdk: resolvedTools.customToolNameToSdk,
						toolWatchNote,
						onContinuityDecision: recordContinuity,
						onResumeFallback: (error) => {
							output.diagnostics = [
								...(output.diagnostics ?? []),
								createAssistantMessageDiagnostic("claude_sdk_oauth_resume_fallback", error),
							];
						},
					})
				: queryWithAuthLane({
						prompt: buildPromptStream(
							buildPromptBlocks(context, resolvedTools.customToolNameToSdk, toolWatchNote),
						),
						query: getSdkBoundary().query,
						providerSettings,
						sessionId: affinityKey,
						pinnedAccount: getSessionClaudeAccountPin(options?.sessionId),
						onQuery: (query) => {
							sdkQuery = query;
							if (wasAborted) requestAbort();
						},
						buildOptions,
					});

			for await (const message of messages) {
				if (!started) {
					stream.push({ type: "start", partial: output });
					started = true;
				}
				if (message.type === "stream_event") {
					sawStreamEvent = true;
					applyStreamEvent(
						{ model, output, blocks, stream, customToolNameToPi: resolvedTools.customToolNameToPi },
						message.event,
					);
				} else if (message.type === "system" && message.subtype === "compact_boundary") {
					// Native compactions must reach the ledger: attach the boundary as a
					// diagnostic so the lane-policy collector can build a ledger entry
					// instead of the boundary being discarded in the stream.
					output.diagnostics = [
						...(output.diagnostics ?? []),
						{
							type: "claude_sdk_oauth_compact_boundary",
							timestamp: Date.now(),
							details: {
								boundary: {
									trigger: message.compact_metadata?.trigger ?? "unknown",
									preTokens: message.compact_metadata?.pre_tokens ?? 0,
									postTokens: message.compact_metadata?.post_tokens ?? 0,
									lineageId: message.session_id ?? "",
									observedAt: Date.now(),
								},
							},
						},
					];
				} else if (message.type === "result" && message.subtype === "success") {
					// Both fields are optional on the wire, so only adopt them when present.
					// A terminal result must never downgrade a toolUse turn that the stream
					// already established, or the agent loop would stop instead of running
					// the tool call sitting in `output.content`.
					if (message.usage) updateUsage(model, output, message.usage);
					if (message.stop_reason != null && output.stopReason !== "toolUse") {
						output.stopReason = mapStopReason(message.stop_reason);
					}
					if (!sawStreamEvent) output.content.push({ type: "text", text: message.result });
				} else if (message.type === "result") {
					const reason =
						"errors" in message && Array.isArray(message.errors) && message.errors.length > 0
							? String(message.errors[0])
							: `Claude Code ${message.subtype}`;
					throw new Error(reason);
				}
			}

			if (wasAborted || options?.signal?.aborted) {
				output.stopReason = "aborted";
				output.errorMessage = "Operation aborted";
				stream.push({ type: "error", reason: "aborted", error: output });
			} else {
				stream.push({
					type: "done",
					reason: output.stopReason === "toolUse" ? "toolUse" : output.stopReason === "length" ? "length" : "stop",
					message: output,
				});
			}
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = withAuthGuidance(error, errorMessage(error));
			stream.push({ type: "error", reason: output.stopReason, error: output });
		} finally {
			options?.signal?.removeEventListener("abort", onAbort);
			closeQuery();
			stream.end();
		}
	})();
	return stream;
}
