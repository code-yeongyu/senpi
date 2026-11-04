import { AsyncLocalStorage } from "node:async_hooks";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { NestedRequest, PlaneHandler } from "@earendil-works/pi-agent-core";
import { RuntimeUiBroker } from "../runtime/ui-broker.ts";
import { type ExtensionRunner, noOpUIContext } from "./runner.ts";
import type { ExtensionUIContext } from "./types.ts";

/**
 * The presentation port (brain/hand split S30). UI an extension produces on the hand while it runs a call (widgets,
 * notices, status, titles, editor text, ...) goes to the loop that owns the call as requests on the call's nested
 * plane, in the order it was produced, and that loop's UI presents it: the UI of the session the client is attached to.
 * Dialogs are not presentations; they stay on the UI broker and the remote dialog path. A fused session never builds
 * the port: its extensions call the attached UI directly.
 */
export const UI_PRESENTATION_PLANE = "ui-presentation";

/** The `ExtensionUIContext` calls that present something and answer nothing, so a port can carry them. */
export const PRESENTATION_METHODS = [
	"notify",
	"setStatus",
	"setSubagentCost",
	"setWorkingMessage",
	"setWorkingVisible",
	"setWorkingIndicator",
	"setHiddenThinkingLabel",
	"setWidget",
	"setTitle",
	"setProgramStatus",
	"pasteToEditor",
	"setEditorText",
	"setToolsExpanded",
] as const satisfies readonly (keyof ExtensionUIContext)[];

export type PresentationMethod = (typeof PRESENTATION_METHODS)[number];

const PRESENTATIONS: ReadonlySet<string> = new Set(PRESENTATION_METHODS);

const isPresentation = (method: unknown): method is PresentationMethod =>
	typeof method === "string" && PRESENTATIONS.has(method);

/** Plain data survives the plane; a component factory or a callback (a `setWidget` factory, an action) cannot. */
function isPlainData(value: unknown): boolean {
	if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") return false;
	if (Array.isArray(value)) return value.every(isPlainData);
	if (typeof value === "object" && value !== null) return Object.values(value).every(isPlainData);
	return true;
}

/** `undefined` arguments are meaningful (`setStatus(key, undefined)` clears), so they travel as explicit markers. */
const UNDEFINED = { $undefined: true } as const;
const encode = (args: readonly unknown[]): JsonValue =>
	args.map((arg) => (arg === undefined ? UNDEFINED : JSON.parse(JSON.stringify(arg)))) as JsonValue;
const isUndefinedMarker = (value: unknown): boolean =>
	typeof value === "object" &&
	value !== null &&
	!Array.isArray(value) &&
	Object.keys(value).length === 1 &&
	(value as Record<string, unknown>).$undefined === true;
const decode = (args: readonly unknown[]): unknown[] => args.map((arg) => (isUndefinedMarker(arg) ? undefined : arg));

type PresentationFn = (...args: unknown[]) => void;

const PRESENTATION_ONLY = Symbol("presentation-only UI");

/**
 * A port presents, but it cannot answer a dialog, so a runner whose UI is a port reports `hasUI` false: an extension
 * that asks only when there is a UI keeps the path it takes without one, as before the port.
 */
export const isPresentationOnly = (ui: ExtensionUIContext | undefined): boolean =>
	ui !== undefined && Object.hasOwn(ui, PRESENTATION_ONLY);

/** One call's port: the UI its handlers and tool see, and the drain the call awaits before it ends. */
export interface PresentationPort {
	readonly ui: ExtensionUIContext;
	/** Waits for every presentation sent so far; rejects with the first one the loop could not take. */
	close(): Promise<void>;
}

/**
 * Opens the port for one running call. Presentations are sent one at a time, in order; dialogs, reads and anything
 * that does not survive the plane stay on `base` (the UI the hand had before the port). After `close`, presentations
 * fall back to `base` too: the call they belonged to has ended, and with it the plane they would have ridden.
 */
export function openPresentationPort(
	nested: NestedRequest,
	base: ExtensionUIContext = noOpUIContext,
): PresentationPort {
	let closed = false;
	let failure: unknown;
	let chain: Promise<void> = Promise.resolve();
	const send = (method: PresentationMethod, args: readonly unknown[]): void => {
		chain = chain.then(async () => {
			if (failure !== undefined) return;
			try {
				await nested(UI_PRESENTATION_PLANE, { method, args: encode(args) });
			} catch (error) {
				failure = error;
			}
		});
	};
	const presentations = Object.fromEntries(
		PRESENTATION_METHODS.map((method) => [
			method,
			(...args: unknown[]): void => {
				if (closed || !isPlainData(args)) {
					(base[method] as PresentationFn | undefined)?.apply(base, args);
					return;
				}
				send(method, args);
			},
		]),
	);
	return {
		ui: { ...base, ...presentations, [PRESENTATION_ONLY]: true } as ExtensionUIContext,
		async close() {
			closed = true;
			await chain;
			if (failure !== undefined) throw failure;
		},
	};
}

/** Where the loop runs: presents a forwarded presentation on this runner's UI (the attached client's). */
export function servePresentation(runner: ExtensionRunner): PlaneHandler {
	return async (body) => {
		const { method, args } = parsePresentation(body);
		const ui = runner.getUIContext();
		(ui[method] as PresentationFn | undefined)?.apply(ui, decode(args));
		return null;
	};
}

function parsePresentation(body: JsonValue): { method: PresentationMethod; args: readonly JsonValue[] } {
	if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("malformed ui presentation");
	const { method, args } = body as { readonly method?: JsonValue; readonly args?: JsonValue };
	if (!Array.isArray(args)) throw new Error("malformed ui presentation");
	if (!isPresentation(method)) throw new Error(`unknown ui presentation ${String(method)}`);
	return { method, args };
}

/**
 * The hand's UI broker: while a call that carries its nested plane runs, its extensions' UI is that call's port, and
 * the call ends only after its presentations are presented. Outside such a call it is the broker it extends: unbound
 * until a presenter attaches, exactly as before.
 */
export class PresentationBroker extends RuntimeUiBroker {
	readonly #calls = new AsyncLocalStorage<ExtensionUIContext>();

	override get presenter(): ExtensionUIContext | undefined {
		return this.#calls.getStore() ?? super.presenter;
	}

	async present<T>(nested: NestedRequest | undefined, run: () => Promise<T>): Promise<T> {
		if (nested === undefined) return run();
		const port = openPresentationPort(nested, super.presenter ?? noOpUIContext);
		let result: T;
		try {
			result = await this.#calls.run(port.ui, run);
		} catch (error) {
			await port.close().catch((delivery: unknown) => {
				throw new AggregateError([error, delivery], "the call failed and its presentations were not delivered");
			});
			throw error;
		}
		await port.close();
		return result;
	}
}
