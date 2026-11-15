import type { AgentToolResult, HandToolResult } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import { type Extension, normalizeToolExposure, type ToolDefinition } from "../../core/extensions/types.ts";
import { LazyToolActivation } from "../../core/lazy-tool-activation.ts";
import type { CustomEntry, SessionEntry, SessionHeader } from "../../core/session-manager.ts";
import type { ToolDefinitionEntry } from "../../core/runtime/bootstrap.ts";
import type { RelocationTarget } from "../../core/session-relocation.ts";
import { parseDocuments, parseWakes, SessionStateContractError } from "../../core/hand/session-state-effects.ts";
import type { CarriedSession, LoopHookCall } from "./loop-hook-call.ts";
import { effectsReply } from "./loop-hook-effects.ts";

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
	const state = carriedState(payload);
	if (state === null) return null;
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
		...state,
	};
}

/** The session state a call carries beside the transcript (documents, wakes, relocation offer), or `null` if malformed. */
function carriedState(
	payload: Record<string, unknown>,
): Pick<CarriedSession, "documents" | "wakes" | "relocation"> | null {
	const { documents, wakes, relocation } = payload;
	try {
		const targets = relocation === undefined ? undefined : relocationTargets(relocation);
		return {
			...(documents === undefined ? {} : { documents: parseDocuments(documents, "documents", false) }),
			...(wakes === undefined ? {} : { wakes: parseWakes(wakes, "wakes") }),
			...(targets === undefined ? {} : { relocation: { targets } }),
		};
	} catch (error) {
		if (error instanceof SessionStateContractError) return null;
		throw error;
	}
}

function relocationTargets(value: unknown): RelocationTarget[] {
	const targets = isRecord(value) ? value.targets : undefined;
	if (!Array.isArray(targets)) throw new SessionStateContractError("relocation.targets is not a list");
	return targets.map((target, index) => {
		if (!isRecord(target) || typeof target.name !== "string" || typeof target.online !== "boolean")
			throw new SessionStateContractError(`relocation.targets[${index}] is not a computer`);
		const { name, online, capacity, aboutToSleep } = target;
		return {
			name,
			online,
			...(typeof capacity === "string" ? { capacity } : {}),
			...(aboutToSleep === true ? { aboutToSleep } : {}),
		};
	});
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
			await effects.settle();
			return { ...result, sessionEffects: JSON.parse(JSON.stringify(effectsReply(effects))) as JsonValue };
		},
		carried,
	);
}

/**
 * Runs one tool call that carries only the calling loop session's id (identity, no record): its tools read the id
 * (`ctx.sessionManager.getSessionId()`), nothing else of the session. Writes its handlers still make go back as
 * `sessionEffects`, as for a call that carries the session.
 */
export function runAsSession(
	tools: Pick<HandSessionTools, "call" | "cwd">,
	sessionId: string,
	run: () => Promise<AgentToolResult<unknown>>,
): Promise<HandToolResult> {
	return tools.call.run(sessionId, tools.cwd, false, async (effects) => {
		const result = await run();
		await effects.settle();
		const reply = effectsReply(effects);
		return Object.keys(reply).length === 0
			? result
			: { ...result, sessionEffects: JSON.parse(JSON.stringify(reply)) as JsonValue };
	});
}
