import type { JsonValue } from "@earendil-works/pi-ai";
import {
	askRemoteDialog,
	type DialogMethod,
	type DialogRequest,
	type NestedRequest,
	type PlaneHandler,
	serveDialogPlane,
} from "@earendil-works/pi-agent-core";
import type { ExtensionRunner } from "./runner.ts";
import { survivesPlane } from "./ui-plane-data.ts";
import type { ExtensionUIContext, ExtensionUIDialogOptions, ExtensionUIInputOptions } from "./types.ts";

type DialogFn = (...args: unknown[]) => Promise<unknown>;

/** The options a dialog's asker may set that mean the same on the loop's UI; `signal` and `timeout` stay with the hand. */
const FORWARDED_OPTIONS = ["ephemeral", "toolCallId", "parentToolCallId", "secret"] as const;

/** Where each dialog keeps its options object, and what it settles with when nobody answers. */
const DIALOGS: Readonly<Record<DialogMethod, { readonly arity: number; readonly fallback: unknown }>> = {
	select: { arity: 2, fallback: undefined },
	confirm: { arity: 2, fallback: false },
	input: { arity: 2, fallback: undefined },
};

const isJson = (value: unknown): value is JsonValue => survivesPlane(value);

function forwardedOptions(options: ExtensionUIInputOptions | undefined): Record<string, JsonValue> {
	const forwarded: Record<string, JsonValue> = {};
	for (const key of FORWARDED_OPTIONS) {
		const value = options?.[key];
		if (value !== undefined && isJson(value)) forwarded[key] = value;
	}
	return forwarded;
}

/**
 * The dialog half of a hand call's port (S26b): each dialog is asked by the loop that owns the call, and the hand waits
 * for its answer. A dialog the loop cannot take (it serves no dialogs, the arguments are not plain data) or one
 * raised after the call ended is asked of `base`, the hand's own UI, as before remote dialogs. The hand's timeout and abort end
 * the wait with the dialog's default, as they do on an RPC client.
 */
export function remoteDialogs(
	nested: NestedRequest,
	base: ExtensionUIContext,
	closed: () => boolean,
): Partial<ExtensionUIContext> {
	const dialog =
		(method: DialogMethod): DialogFn =>
		async (...args: unknown[]) => {
			const { arity, fallback } = DIALOGS[method];
			const own = args.slice(0, arity);
			const options = args[arity] as ExtensionUIInputOptions | undefined;
			const local = (): Promise<unknown> =>
				(base[method] as DialogFn | undefined)?.apply(base, args) ?? Promise.resolve(fallback);
			if (closed() || !own.every((arg) => arg === undefined || isJson(arg))) return local();
			const request: DialogRequest = {
				method,
				args: [...own.map((arg) => (arg === undefined ? null : (arg as JsonValue))), forwardedOptions(options)],
				...(options?.timeout === undefined ? {} : { timeoutMs: options.timeout }),
			};
			const outcome = await askRemoteDialog(nested, request, options?.signal);
			if (outcome.kind === "unavailable") return local();
			return outcome.kind === "answered" ? (outcome.value ?? fallback) : fallback;
		};
	return {
		select: dialog("select") as ExtensionUIContext["select"],
		confirm: dialog("confirm") as ExtensionUIContext["confirm"],
		input: dialog("input") as ExtensionUIContext["input"],
	};
}

/** Where the loop runs: asks a hand's dialog on this runner's UI (the attached client's, or RPC answerers'). */
export function serveDialog(runner: ExtensionRunner): PlaneHandler {
	return serveDialogPlane(async ({ method, args, timeoutMs }, signal) => {
		const { arity } = DIALOGS[method];
		const own = args.slice(0, arity).map((arg) => (arg === null ? undefined : arg));
		const forwarded = (args[arity] ?? {}) as ExtensionUIDialogOptions;
		const options: ExtensionUIInputOptions = {
			...forwarded,
			signal,
			...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
		};
		const ui = runner.getUIContext();
		const ask = ui[method] as DialogFn | undefined;
		if (ask === undefined) return undefined;
		const answer = await ask.apply(ui, [...own, options]);
		return answer === undefined || !isJson(answer) ? undefined : answer;
	});
}
