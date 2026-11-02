/**
 * The terminal control endpoint's session controls: a model switch, a thinking level and an interrupt.
 * Each one runs the pane's own path (`/model`, the thinking-level selector, Esc) through the surface,
 * so validation, the footer and persistence are the ones the user gets typing it there.
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "../../core/agent-session.ts";
import {
	availableModelsData,
	interruptRunningTurn,
	unsupportedThinkingLevel,
} from "../rpc/session-control-actions-data.ts";
import { type ControlCommand, failure, success } from "./session-control-server.ts";

export interface TuiSessionControls {
	/** The `/model` path: switches, updates the footer and records the default; throws a refusal. */
	selectModel(model: Model<string>): Promise<{ readonly systemPromptName?: string } | undefined>;
	/** The thinking-level selector: `remember` is its Ctrl+S (the model's remembered level). */
	selectThinkingLevel(level: ThinkingLevel, remember: boolean): void;
	/** Esc on a running turn: queued input returns to the editor, the turn aborts and settles. */
	interruptTurn(): Promise<void>;
}

export const SESSION_CONTROL_COMMANDS = [
	"get_available_models",
	"get_available_thinking_levels",
	"set_model",
	"set_thinking_level",
	"interrupt",
] as const;

export async function runSessionControlCommand(
	session: AgentSession,
	controls: TuiSessionControls,
	command: ControlCommand,
): Promise<object | undefined> {
	const { id, type } = command;
	switch (type) {
		case "get_available_models":
			return success(id, type, await availableModelsData(session));
		case "get_available_thinking_levels":
			return success(id, type, { levels: session.getAvailableThinkingLevels() });
		case "set_model":
			return await setModel(session, controls, command);
		case "set_thinking_level": {
			const level = session.getAvailableThinkingLevels().find((candidate) => candidate === command.level);
			if (level === undefined) return failure(id, type, unsupportedThinkingLevel(command.level));
			controls.selectThinkingLevel(level, command.scope !== "turn");
			return success(id, type);
		}
		case "interrupt":
			return success(id, type, await interruptRunningTurn(session, command.turnId, () => controls.interruptTurn()));
		default:
			return undefined;
	}
}

async function setModel(session: AgentSession, controls: TuiSessionControls, command: ControlCommand): Promise<object> {
	const { id, type } = command;
	const models = await session.modelRegistry.getAvailable();
	const model = models.find(
		(candidate) => candidate.provider === command.provider && candidate.id === command.modelId,
	);
	if (model === undefined) {
		return failure(id, type, `Model not found: ${String(command.provider)}/${String(command.modelId)}`);
	}
	try {
		const change = await controls.selectModel(model);
		return success(id, type, { ...model, systemPromptName: change?.systemPromptName });
	} catch (error) {
		return failure(id, type, error instanceof Error ? error.message : String(error));
	}
}
