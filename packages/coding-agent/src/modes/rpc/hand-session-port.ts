import type { AgentToolResult, HandToolResult } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import { type Extension, normalizeToolExposure, type ToolDefinition } from "../../core/extensions/types.ts";
import { LazyToolActivation } from "../../core/lazy-tool-activation.ts";
import type { CustomEntry, SessionEntry, SessionHeader } from "../../core/session-manager.ts";
import type { ToolDefinitionEntry } from "../../core/runtime/bootstrap.ts";
import { type CarriedSession, effectsReply, type LoopHookCall } from "./loop-hook-call.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isCustomEntry = (value: unknown): value is CustomEntry =>
	isRecord(value) && value.type === "custom" && typeof value.customType === "string" && typeof value.id === "string";

/** A carried branch holds the hand's own (custom) entries and the user's messages, nothing the loop keeps to itself. */
const isBranchEntry = (value: unknown): value is SessionEntry =>
	isCustomEntry(value) ||
	(isRecord(value) &&
		value.type === "message" &&
		typeof value.id === "string" &&
		isRecord(value.message) &&
		value.message.role === "user");

const isHeader = (value: unknown): value is SessionHeader =>
	isRecord(value) && value.type === "session" && typeof value.id === "string" && typeof value.cwd === "string";

const isNames = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((name) => typeof name === "string");

/**
 * The session port's read half a call carries (see {@link CarriedSession}), or `null` when malformed. Each hand entry
 * is a custom entry: the hand only ever authored custom entries.
 */
export function parseCarriedSession(payload: Record<string, unknown>): CarriedSession | null {
	const { leafId, handEntries, branch, header, activeTools, systemPromptOptions } = payload;
	if (!(leafId === null || typeof leafId === "string")) return null;
	if (!Array.isArray(handEntries) || !handEntries.every(isCustomEntry)) return null;
	if (!(branch === undefined || (Array.isArray(branch) && branch.every(isBranchEntry)))) return null;
	if (!(header === undefined || isHeader(header)) || !(activeTools === undefined || isNames(activeTools))) return null;
	if (!(systemPromptOptions === undefined || isRecord(systemPromptOptions))) return null;
	return {
		leafId,
		handEntries,
		...(branch === undefined ? {} : { branch }),
		...(header === undefined ? {} : { header }),
		...(activeTools === undefined ? {} : { activeTools }),
		...(systemPromptOptions === undefined ? {} : { systemPromptOptions }),
	};
}

/** A tool call's carried session: the loop session it belongs to, its idle state and its read half. */
interface SessionCall {
	readonly sessionId: string;
	readonly idle: boolean;
	readonly carried: CarriedSession;
}

function parseSessionCall(session: JsonValue): SessionCall {
	const carried = isRecord(session) ? parseCarriedSession(session) : null;
	if (!isRecord(session) || typeof session.sessionId !== "string" || carried === null)
		throw new Error("malformed carried session");
	if (!(session.idle === undefined || typeof session.idle === "boolean")) throw new Error("malformed carried session");
	return { sessionId: session.sessionId, idle: session.idle ?? false, carried };
}

/** The result a session's loop gives a call to a tool it cannot resolve (agent-core `executor.ts`, no hint). */
const notCallable = (toolName: string): AgentToolResult<unknown> => ({
	content: [{ type: "text", text: `Tool ${toolName} not found` }],
	details: {},
	isError: true,
});

/** Whether a session activates the tool when it registers (`direct`, `eval`, `model-only` exposure, unless opted out). */
const activeOnRegistration = (definition: ToolDefinition): boolean => {
	const { exposure } = normalizeToolExposure(definition);
	return (
		(exposure === "direct" || exposure === "eval" || exposure === "model-only") && definition.defaultActive !== false
	);
};

/** What runs a hosted loop's session tool on a hand: its runtime's session-call state and tool registry. */
export interface HandSessionTools {
	readonly call: LoopHookCall;
	readonly cwd: string;
	readonly definition: (name: string) => ToolDefinitionEntry | undefined;
	readonly extensions: readonly Extension[];
}

/**
 * Runs one tool call of a loop that runs elsewhere with that loop's session (senpi#6754, ST): the tool and its handlers
 * read the session the call carried and their writes come back as the result's `sessionEffects`, which the loop commits.
 * A tool that needs activation (one a session does not activate on registration) and that the carried active set lacks
 * is activated first, as a session's lazy activation does on its first call, so the loop applies the new set; one that
 * cannot be activated is refused as the session refuses a tool it cannot call, and never runs. A tool active on
 * registration is callable as in any session, whether or not the loop's set names it (it may be this machine's own).
 * Malformed carried facts refuse the call before anything runs.
 */
export function runInSession(
	tools: HandSessionTools,
	session: JsonValue,
	toolName: string,
	run: () => Promise<AgentToolResult<unknown>>,
): Promise<HandToolResult> {
	const { sessionId, idle, carried } = parseSessionCall(session);
	const activation = new LazyToolActivation({
		getToolDefinition: (name) => tools.definition(name)?.definition,
		getActiveTools: () => tools.call.current()?.getActiveTools() ?? [],
		setActiveTools: (names) => tools.call.current()?.setActiveTools(names),
	});
	for (const extension of tools.extensions)
		for (const activator of extension.lazyToolActivators ?? []) activation.register(activator);
	return tools.call.run(
		sessionId,
		tools.cwd,
		idle,
		async (effects) => {
			const definition = tools.definition(toolName)?.definition;
			const callable =
				carried.activeTools === undefined ||
				carried.activeTools.includes(toolName) ||
				(definition !== undefined && activeOnRegistration(definition)) ||
				activation.activate(toolName);
			const result = callable ? await run() : notCallable(toolName);
			return { ...result, sessionEffects: JSON.parse(JSON.stringify(effectsReply(effects))) as JsonValue };
		},
		carried,
	);
}
