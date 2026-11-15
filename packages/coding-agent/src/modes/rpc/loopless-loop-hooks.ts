import type { JsonValue } from "@earendil-works/pi-ai";
import { type ForwardedLoopEvent, LOOP_HOOK_FORWARDING } from "../../core/extensions/event-placement.ts";
import type { ExtensionRunner } from "../../core/extensions/runner.ts";
import type { TwoSidedHome } from "./loopless-tool-handlers.ts";
import type { LoopHookCall } from "./loop-hook-call.ts";
import { COMPACTION_LOOP_HOOKS } from "./loop-hook-compaction-events.ts";
import { LIFECYCLE_LOOP_HOOKS } from "./loop-hook-lifecycle-events.ts";
import { MESSAGE_LOOP_HOOKS } from "./loop-hook-message-events.ts";
import { isRecord, type LoopHookParser } from "./loop-hook-payloads.ts";
import { PROVIDER_LOOP_HOOKS } from "./loop-hook-provider-events.ts";
import { createMessageStreams } from "./loop-hook-message-stream.ts";
import { loopHookReply } from "./loop-hook-reply.ts";
import { SESSION_LOOP_HOOKS } from "./loop-hook-session-events.ts";
import { SESSION_MOVE_LOOP_HOOKS } from "./loop-hook-session-move.ts";
import { TURN_LOOP_HOOKS } from "./loop-hook-turn-events.ts";
import { TURN_EVIDENCE } from "./loop-hook-turn-evidence.ts";

/** The loop events a hand that is its extensions' home runs for a loop that runs elsewhere (S33, C8/K5). */
export type LooplessLoopHooks = (event: string, payload: JsonValue, cancel?: AbortSignal) => Promise<JsonValue>;

/** Every forwarded loop-side event's parser; an event `LOOP_HOOK_FORWARDING` forwards fails to compile without one. */
const LOOP_HOOK_PARSERS = {
	...LIFECYCLE_LOOP_HOOKS,
	...TURN_LOOP_HOOKS,
	...MESSAGE_LOOP_HOOKS,
	...SESSION_LOOP_HOOKS,
	...COMPACTION_LOOP_HOOKS,
	...SESSION_MOVE_LOOP_HOOKS,
	...PROVIDER_LOOP_HOOKS,
} as const satisfies Record<ForwardedLoopEvent, LoopHookParser>;

/** The forwarded events the loop gates on `wants`: every notification (interceptors are always forwarded). */
const GATED_EVENTS = Object.keys(LOOP_HOOK_PARSERS)
	.filter(isForwarded)
	.filter((event) => LOOP_HOOK_FORWARDING[event] === "notification");

function isForwarded(event: string): event is ForwardedLoopEvent {
	return Object.hasOwn(LOOP_HOOK_PARSERS, event) && Object.hasOwn(LOOP_HOOK_FORWARDING, event);
}

/**
 * The call a loop makes before forwarding: its reply `{ wants }` lists the notifications a user hook of this hand
 * listens to, so the loop forwards only those (a per-token `message_update` or `provider_stream_event` nobody wants
 * never crosses the link); it forwards every interceptor whatever `wants` says (see `LOOP_HOOK_FORWARDING`). An
 * extension may subscribe or unsubscribe at any time (`pi.on`, a builtin's lazy subscription), so from then on every
 * reply whose `wants` differs from the set the hand last reported carries the new set as `wants`, and the loop uses it
 * from its next dispatch. The loop asks again when the hand process changed (a new `hook.hello`).
 */
const DESCRIBE_HOOKS = "describe_hooks";

/** The hand's `wants` and the set it last reported to the loop (none before the loop's first `describe_hooks`). */
function wantsTracker(runner: ExtensionRunner) {
	let reported: string | undefined;
	const wanted = (only: (extensionPath: string) => boolean) =>
		GATED_EVENTS.filter((event) => runner.hasHandlers(event, only));
	return {
		describe(only: (extensionPath: string) => boolean): string[] {
			const wants = wanted(only);
			reported = wants.join();
			return wants;
		},
		/** The current set when it differs from the one last reported (which it then becomes), else `undefined`. */
		changed(only: (extensionPath: string) => boolean): string[] | undefined {
			if (reported === undefined) return undefined;
			const wants = wanted(only);
			if (wants.join() === reported) return undefined;
			reported = wants.join();
			return wants;
		},
	};
}

/**
 * The loop hooks of this runtime's own extensions, on the same runner (so the same extension instances) that runs its
 * tool calls: a two-sided extension keeps one state across its loop and tool hooks. Only a hand that is its extensions'
 * home (`twoSidedHome: "hand"`) runs them; any other hand refuses, because its extensions' loop hooks run where the loop
 * runs. Every event runs only the user's loop hooks (`userLoopHooks`: non-builtin extensions the loader did not ship,
 * plus the hooks builtin); the loop's own builtins run where the loop runs. A loop forwards every loop-side event `LOOP_HOOK_FORWARDING` does not keep loop-only (senpi#5898), in a
 * session's order, each parsed at this boundary by its family's module. An interceptor's reply carries the result its
 * handlers merged as a session's emit merges it (the loop returns it from its own handler); every reply also carries
 * what the handlers sent (`sent`), notified (`notices`), wrote to the session (`entries`, `userMessages`) and their
 * failures (`errors`). `cancel` aborts when the loop cancels the call; the handlers' signal then aborts while they run.
 */
export function extensionLoopHooks(
	runner: ExtensionRunner,
	twoSidedHome: TwoSidedHome,
	cwd: string,
	call: LoopHookCall,
): LooplessLoopHooks {
	const wants = wantsTracker(runner);
	const streams = createMessageStreams();
	return async (event, payload, cancel) => {
		if (twoSidedHome !== "hand") throw new Error("this hand is not the home of its extensions' loop hooks");
		const only = userLoopHooks(runner);
		if (event === DESCRIBE_HOOKS) return { wants: wants.describe(only) };
		if (!isRecord(payload) || typeof payload.sessionId !== "string" || typeof payload.idle !== "boolean")
			throw new Error(`malformed ${event} payload`);
		if (!isForwarded(event)) throw new Error(`no loop hooks run on a hand for ${event}`);
		const { sessionId } = payload;
		const parsed = LOOP_HOOK_PARSERS[event](payload, { cwd, sessionId, streams });
		if (event === "session_shutdown") streams.end(sessionId);
		const turn = TURN_EVIDENCE[event](payload);
		const binding = {
			sessionId,
			cwd,
			idle: payload.idle,
			...parsed.binding,
			...(turn === undefined ? {} : { turn }),
			...(cancel === undefined ? {} : { cancel }),
		};
		return call.run(binding, (effects, signal) =>
			loopHookReply(event, { runner, call, effects, wantsChange: () => wants.changed(only) }, () =>
				parsed.emit({ runner, only, signal }),
			),
		);
	};
}

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
