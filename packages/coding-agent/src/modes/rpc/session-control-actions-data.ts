/**
 * The session-control answers a multi-session host and a terminal control endpoint share, so a caller
 * reads the same shapes from either: the model catalog, the thinking-level refusal, and the
 * `interrupt` outcome.
 */
import { modelSupportsAssistantPrefill } from "@earendil-works/pi-ai";
import type { AgentSession } from "../../core/agent-session.ts";
import type { RunBackgroundStopOutcome } from "../../core/run-background-jobs.ts";
import { getSupportedThinkingLevels } from "../../core/thinking-levels.ts";

export async function availableModelsData(session: AgentSession): Promise<{ models: readonly object[] }> {
	const registry = session.modelRegistry;
	const models = await registry.modelRuntime.getAvailable();
	return {
		models: models.map((model) => {
			// A models.json or extension definition can declare the priority pairing without putting it on
			// the Model object; clients must see the values the session itself acts on (#3666).
			const serviceTier = registry.getServiceTier(model);
			const upstreamModelId = registry.getUpstreamModelId(model);
			return {
				...model,
				...(serviceTier === undefined ? {} : { serviceTier }),
				...(upstreamModelId === undefined ? {} : { upstreamModelId }),
				supportedThinkingLevels: getSupportedThinkingLevels(model),
				supportsAssistantPrefill: modelSupportsAssistantPrefill(model, {
					thinkingEnabled: session.thinkingLevel !== "off",
				}),
			};
		}),
	};
}

/** The refusal of a level the active model cannot run; callers match this text. */
export function unsupportedThinkingLevel(level: unknown): string {
	return `Thinking level ${String(level)} is not supported by the active model.`;
}

export interface InterruptOutcome {
	readonly interrupted: boolean;
	readonly turnId?: string;
	/** Present when the caller asked `background: "stop"`: the interrupted turn's background jobs it stopped. */
	readonly background?: RunBackgroundStopOutcome;
}

const NOTHING_STOPPED: RunBackgroundStopOutcome = { stopped: [], failed: [] };

/**
 * `interrupt { turnId?, background? }`: stops the running turn and only that. An idle session answers
 * `interrupted: false`; so does a `turnId` naming a turn that is no longer the running one, which
 * then answers the running turn's id. `stop` resolves once the turn has stopped; with `background:
 * "stop"` the background jobs that turn started are stopped after it, and the answer names them.
 */
export async function interruptRunningTurn(
	session: AgentSession,
	requestedTurnId: unknown,
	stop: () => Promise<void>,
	background?: unknown,
): Promise<InterruptOutcome> {
	const stopsBackground = background === "stop";
	const nothing = stopsBackground ? { background: NOTHING_STOPPED } : {};
	if (!session.isStreaming && session.retryAttempt === 0) return { interrupted: false, ...nothing };
	const turnId = String(session.externalAdmission.turnEpoch);
	if (typeof requestedTurnId === "string" && requestedTurnId !== turnId)
		return { interrupted: false, turnId, ...nothing };
	await stop();
	if (!stopsBackground) return { interrupted: true, turnId };
	return { interrupted: true, turnId, background: await session.stopRunBackgroundJobs(turnId) };
}
