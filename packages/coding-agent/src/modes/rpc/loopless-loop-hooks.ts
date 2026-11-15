import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, JsonValue } from "@earendil-works/pi-ai";
import type { ExtensionRunner } from "../../core/extensions/runner.ts";
import type {
	BeforeAgentStartEvent,
	InputAttribution,
	InputSource,
	SessionStartEvent,
} from "../../core/extensions/types.ts";
import { hookModelOf, hookRequestOutputOf, parseHookRequestInput } from "../../core/hand/hook-contract.ts";
import type { CustomEntry } from "../../core/session-manager.ts";
import type { BuildSystemPromptOptions } from "../../core/system-prompt.ts";
import type { TwoSidedHome } from "./loopless-tool-handlers.ts";
import type { CarriedSession, LoopHookCall, LoopHookEffects, LoopTurnEvidence } from "./loop-hook-call.ts";

/** The loop events a hand that is its extensions' home runs for a loop that runs elsewhere (S33, C8/K5). */
export type LooplessLoopHooks = (event: string, payload: JsonValue) => Promise<JsonValue>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The loop hooks of this runtime's own extensions, on the same runner (so the same extension instances) that runs its
 * tool calls: a two-sided extension keeps one state across its loop and tool hooks. Only a hand that is its extensions'
 * home (`twoSidedHome: "hand"`) runs them; any other hand refuses, because its extensions' loop hooks run where the loop
 * runs. Every event runs only the user's loop hooks (`userLoopHooks`: non-builtin extensions the loader did not ship,
 * plus the hooks builtin); the loop's own builtins run where the loop runs. The loop forwards, in a session's order:
 * - `session_start`: the user's SessionStart hooks and extensions' `session_start` handlers;
 * - `input` (the hooks builtin's UserPromptSubmit runs there), whose result (`continue`, `handled`, or `transform`
 *   with the new text) the loop returns from its own `input` handler, so its session acts on it as on a local one;
 * - `before_agent_start` with the prompt the session now has, whose combined result the loop returns from its own;
 * - `before_provider_request` (CK21), whose reply's `output` carries the payload the user's hooks produced;
 * - `agent_end`, carrying the session port's read half, where the user's Stop hooks run.
 * Each reply also carries what its handlers did beyond the result: messages (`sent`, which the loop sends with the same
 * options), notices, session writes (`entries`, `userMessages`), late effects of earlier calls' work (and
 * `droppedLate`), and failures (`errors`).
 */
export function extensionLoopHooks(
	runner: ExtensionRunner,
	twoSidedHome: TwoSidedHome,
	cwd: string,
	call: LoopHookCall,
): LooplessLoopHooks {
	return async (event, payload) => {
		if (twoSidedHome !== "hand") throw new Error("this hand is not the home of its extensions' loop hooks");
		if (!isServedLoopEvent(event)) throw new Error(`no loop hooks run on a hand for ${event}`);
		const only = userLoopHooks(runner);
		if (!isRecord(payload) || typeof payload.sessionId !== "string" || typeof payload.idle !== "boolean")
			throw new Error(`malformed ${event} payload`);
		const { sessionId, idle } = payload;
		const turn = TURN_EVIDENCE[event](payload);
		const binding = { sessionId, cwd, idle, ...(turn === undefined ? {} : { turn }) };
		const images = imagesOf(payload.images);
		if (images === null) throw new Error(`malformed ${event} payload: images`);
		if (event === "input") {
			const { inputId, text, source, attribution, streamingBehavior } = payload;
			if (
				typeof inputId !== "string" ||
				typeof text !== "string" ||
				!isOneOf(source, INPUT_SOURCES) ||
				!isOneOf(attribution, INPUT_ATTRIBUTIONS) ||
				!(streamingBehavior === undefined || isOneOf(streamingBehavior, STREAMING_BEHAVIORS))
			)
				throw new Error("malformed input payload");
			return call.run(binding, (effects) =>
				dispatchLoopHook(runner, call, effects, () =>
					runner.emitInput(text, images, source, streamingBehavior, inputId, attribution, only),
				),
			);
		}
		if (event === "before_agent_start") {
			const { prompt, systemPrompt, trigger, preview, systemPromptOptions } = payload;
			if (
				typeof prompt !== "string" ||
				typeof systemPrompt !== "string" ||
				!isOneOf(trigger, TRIGGERS) ||
				!(preview === undefined || typeof preview === "boolean") ||
				!isRecord(systemPromptOptions)
			)
				throw new Error("malformed before_agent_start payload");
			// The loop's options as the loop built them: only `cwd` is this machine's (its workspace); the rest (context files,
			// skills, tools) describes the loop's machine. They are data for handlers to read; nothing here acts on them.
			const options = { ...(systemPromptOptions as Partial<BuildSystemPromptOptions>), cwd };
			return call.run(binding, (effects) =>
				dispatchLoopHook(runner, call, effects, () =>
					runner.emitBeforeAgentStart(prompt, images, systemPrompt, options, {
						only,
						trigger,
						...(preview === undefined ? {} : { preview }),
					}),
				),
			);
		}
		if (event === "before_provider_request") {
			// The hosted loop's request hooks (CK21): the user's hooks get the projected input (payload and effective model,
			// no headers), and the reply's `output` carries the payload they produced.
			const input = parseHookRequestInput(payload.input);
			const model = hookModelOf(input);
			return call.run(binding, (effects) =>
				dispatchLoopHook(runner, call, effects, async () => ({
					output: hookRequestOutputOf(
						input,
						await runner.emitBeforeProviderRequest(structuredClone(input.payload), undefined, undefined, {
							only,
							...(model === undefined ? {} : { model }),
						}),
					),
				})),
			);
		}
		if (event === "session_start") {
			const { reason, previousSessionFile } = payload;
			if (
				!isOneOf(reason, SESSION_START_REASONS) ||
				!(previousSessionFile === undefined || typeof previousSessionFile === "string")
			)
				throw new Error("malformed session_start payload");
			const sessionStart = {
				type: "session_start" as const,
				reason,
				...(previousSessionFile === undefined ? {} : { previousSessionFile }),
			};
			return call.run(binding, (effects) =>
				dispatchLoopHook(runner, call, effects, () => runner.emitForwardedLoopEvent(sessionStart, only)),
			);
		}
		if (event === "agent_end") {
			const { messages, aborted } = payload;
			const carried = carriedSessionOf(payload);
			if (!isAgentMessages(messages) || !(aborted === undefined || typeof aborted === "boolean") || carried === null)
				throw new Error("malformed agent_end payload");
			const agentEnd = { type: "agent_end" as const, messages, ...(aborted === undefined ? {} : { aborted }) };
			// An agent_end ends the loop's turn: a Stop held for the hand's background work runs after this call, with the
			// session it carried (it holds the call's idleness until it settles), and its writes ride the session's next reply. The hand cannot push them sooner: while the
			// loop stays idle, that next call is the user's next prompt, so a held Stop's block follow-up does not continue
			// the agent by itself as a local idle session's does, until hand-to-loop push lands (senpi#5778).
			return call.run({ ...binding, carried }, (effects) =>
				dispatchLoopHook(runner, call, effects, () => runner.emitForwardedLoopEvent(agentEnd, only)),
			);
		}
		return event satisfies never;
	};
}

/**
 * What each event a hand serves proves about its loop session's turn (#6770 review M1). Its keys are the only events a
 * hand serves, so a new served event cannot be dispatched until it is classified here. `agent_start` and `turn_start`,
 * which slice 4 (#6766) forwards as notifications, must be `"running"` evidence: continuation turns (auto-retry,
 * compaction recovery, a queued or `agent_before_settle` continuation) start with them and no `before_agent_start`.
 */
const TURN_EVIDENCE = {
	// The loop may handle an input without a turn; a turn it starts arrives as before_agent_start.
	input: () => undefined,
	session_start: () => undefined,
	// A preview composes a turn's prompt without starting the turn.
	before_agent_start: (payload) => (payload.preview === true ? undefined : ("running" as const)),
	// A model request sent mid-turn (`idle: false`), the first a hand sees of a continuation turn.
	before_provider_request: (payload) => (payload.idle === false ? ("running" as const) : undefined),
	agent_end: () => "ended" as const,
} satisfies Record<string, (payload: Readonly<Record<string, unknown>>) => LoopTurnEvidence | undefined>;

type ServedLoopEvent = keyof typeof TURN_EVIDENCE;

const isServedLoopEvent = (event: string): event is ServedLoopEvent => Object.hasOwn(TURN_EVIDENCE, event);

const HOOKS_BUILTIN_PATH = "<builtin:hooks>";

/**
 * The user's loop hooks, which a hand runs for a hosted loop: its non-builtin extensions (C7(c), K5) and the hooks
 * builtin, which runs the user's shell hooks (C8). Every other builtin is the loop's own machinery (model, compaction,
 * todo, search): each side loads its own builtins, so those run where the loop runs, as S29 never forwards builtins.
 */
export const isUserLoopHook = (extensionPath: string): boolean =>
	!extensionPath.startsWith("<builtin:") || extensionPath === HOOKS_BUILTIN_PATH;

/**
 * `isUserLoopHook` by the loader's provenance: an extension the loader shipped (a bundled module such as codemode, or a
 * global-default shim) is a builtin too, whatever its path, so it runs where the loop runs.
 */
function userLoopHooks(runner: ExtensionRunner): (extensionPath: string) => boolean {
	const shipped = runner.getBuiltinProvenancePaths();
	return (path) => isUserLoopHook(path) && (path === HOOKS_BUILTIN_PATH || !shipped.has(path));
}

const INPUT_SOURCES = ["interactive", "rpc", "extension"] as const satisfies readonly InputSource[];
const INPUT_ATTRIBUTIONS = ["user", "agent"] as const satisfies readonly InputAttribution[];
const STREAMING_BEHAVIORS = ["steer", "followUp"] as const;
const SESSION_START_REASONS = [
	"startup",
	"reload",
	"new",
	"resume",
	"fork",
] as const satisfies readonly SessionStartEvent["reason"][];
const TRIGGERS = ["prompt", "delivery", "extension"] as const satisfies readonly BeforeAgentStartEvent["trigger"][];

const isOneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T =>
	typeof value === "string" && (allowed as readonly string[]).includes(value);

/** The images of a loop event, `undefined` when it has none, `null` when they are malformed. */
const imagesOf = (value: unknown): ImageContent[] | undefined | null =>
	value === undefined ? undefined : Array.isArray(value) && value.every(isImage) ? value : null;

/** The loop's transcript messages of an `agent_end`, as data its handlers read (the Stop hook its last stop reason). */
const isAgentMessages = (value: unknown): value is AgentMessage[] =>
	Array.isArray(value) && value.every((message) => isRecord(message) && typeof message.role === "string");

/**
 * The session port's read half a call carries (`leafId`, `handEntries`; see `CarriedSession`), or `null` when
 * malformed. Each hand entry is a custom entry: the hand only ever authored custom entries.
 */
function carriedSessionOf(payload: Record<string, unknown>): CarriedSession | null {
	const { leafId, handEntries } = payload;
	if (!(leafId === null || typeof leafId === "string")) return null;
	if (!Array.isArray(handEntries) || !handEntries.every(isCustomEntry)) return null;
	return { leafId, handEntries };
}

const isCustomEntry = (value: unknown): value is CustomEntry =>
	isRecord(value) && value.type === "custom" && typeof value.customType === "string" && typeof value.id === "string";

const isImage = (value: unknown): value is ImageContent =>
	isRecord(value) && value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string";

async function dispatchLoopHook(
	runner: ExtensionRunner,
	call: LoopHookCall,
	effects: LoopHookEffects,
	dispatch: () => Promise<object | undefined>,
): Promise<JsonValue> {
	// A handler's failure is reported, not thrown, as in a session; here it goes back to the loop host with the result.
	// The runner is shared with tool calls, so only failures inside this call's own async context are its own.
	const own = call.current();
	const errors: { extensionPath: string; event: string; error: string }[] = [];
	const stop = runner.onError(({ extensionPath, event, error }) => {
		if (own !== undefined && call.current() === own) errors.push({ extensionPath, event, error });
	});
	try {
		const result = await dispatch();
		const { sent, notices, entries, userMessages } = effects;
		return JSON.parse(
			JSON.stringify({
				...result,
				...(sent.length > 0 ? { sent } : {}),
				...(notices.length > 0 ? { notices } : {}),
				...(entries.length > 0 ? { entries } : {}),
				...(userMessages.length > 0 ? { userMessages } : {}),
				...(effects.dropped > 0 ? { droppedLate: effects.dropped } : {}),
				...(errors.length > 0 ? { errors } : {}),
			}),
		) as JsonValue;
	} finally {
		stop();
	}
}
