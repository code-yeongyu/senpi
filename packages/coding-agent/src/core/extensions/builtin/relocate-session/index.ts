import { Type } from "typebox";
import type {
	RelocationRequestResult,
	RelocationTarget,
	RelocationTargetsResult,
} from "../../session-control-types.ts";
import type { AgentToolResult, ExtensionAPI } from "../../types.ts";

function toolText<T>(text: string, details: T): AgentToolResult<T> {
	return { content: [{ type: "text", text }], details };
}

function describeTarget(target: RelocationTarget): string {
	const notes = [
		target.online ? "online" : "offline",
		...(target.capacity === undefined ? [] : [`capacity: ${target.capacity}`]),
		...(target.aboutToSleep === true ? ["about to sleep"] : []),
	];
	return `- ${target.name} (${notes.join(", ")})`;
}

export function targetsText(result: RelocationTargetsResult): string {
	switch (result.status) {
		case "listed":
			return result.targets.length === 0
				? "No other computer is offered right now. Keep working on this computer."
				: `You can continue this session on:\n${result.targets.map(describeTarget).join("\n")}`;
		case "unavailable":
		case "refused":
			return `Moving to another computer is not possible here (${result.detail}). Keep working on this computer.`;
	}
}

export function requestText(result: RelocationRequestResult): string {
	switch (result.status) {
		case "scheduled":
			return `The session will continue on ${result.target} when this turn ends. Finish this turn with a short note for the user; the conversation and any queued messages continue on ${result.target}, so do not start new work here.`;
		case "unavailable":
			return `This session can't move to another computer (${result.detail}). It stays on this computer; keep working here.`;
		case "refused":
			return `The move did not happen: ${result.detail}. The session stays on this computer; keep working here.`;
	}
}

const RELOCATION_TOOLS = ["list_relocation_targets", "relocate_session"];

/**
 * The tools are registered search-exposed with lazy activation off, so a session no host offers relocation for (a
 * plain CLI) never sees them. They are activated at the start of each run while the host offers it, and retired again
 * when it no longer does.
 */
function syncActivation(pi: ExtensionAPI): void {
	const wanted = pi.session.relocationOffered();
	const active = pi.getActiveTools();
	const others = active.filter((name) => !RELOCATION_TOOLS.includes(name));
	const next = wanted ? [...others, ...RELOCATION_TOOLS] : others;
	if (next.length === active.length && next.every((name) => active.includes(name))) return;
	pi.setActiveTools(next);
}

export default function relocateSessionExtension(pi: ExtensionAPI): void {
	pi.on("session_start", () => syncActivation(pi));
	// Preview-safe: the prompt-cache prewarm and keep-alive compose the next turn's prefix through a preview pass that
	// must see the tools the turn will send, so a preview changes nothing and a real turn settles the activation.
	pi.on(
		"before_agent_start",
		(event) => {
			if (event.preview !== true) syncActivation(pi);
		},
		{ previewSafe: true },
	);
	pi.registerTool({
		name: "list_relocation_targets",
		label: "Other Computers",
		description:
			"List the user's other computers this session could continue on, as offered by the app running it: name, whether it is online, a capacity hint, and whether it is about to sleep. Read-only.",
		parameters: Type.Object({}, { additionalProperties: false }),
		exposure: "search",
		allowLazyActivation: false,
		async execute(_toolCallId, _params, signal) {
			const result = await pi.session.relocationTargets(signal);
			return toolText(targetsText(result), result);
		},
	});

	pi.registerTool({
		name: "relocate_session",
		label: "Continue on Another Computer",
		description:
			"Continue this session on another of the user's computers, for example a stronger one for heavy work or because this one is about to sleep. The current turn is never cut short: the move happens when this turn ends, and the conversation, its id and any queued messages continue there. Name a computer from list_relocation_targets. If the move is not possible, the session stays here and keeps working.",
		parameters: Type.Object(
			{
				target: Type.String({ description: "Name of the computer to continue on, from list_relocation_targets." }),
				reason: Type.String({ description: "Why, in a short sentence the user will see." }),
			},
			{ additionalProperties: false },
		),
		exposure: "search",
		allowLazyActivation: false,
		async execute(_toolCallId, params, signal) {
			const result = await pi.session.requestRelocation({ target: params.target, reason: params.reason }, signal);
			return toolText(requestText(result), result);
		},
	});
}
