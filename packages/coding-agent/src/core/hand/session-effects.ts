/**
 * The write half of the session port (senpi#6754) as a loop receives it: what one hand call did to the session it
 * carried, returned in that call's result as `sessionEffects`. `parseSessionEffects` is its closed parser at the remote
 * boundary: a loop commits only what it accepted, and it refuses every kind and member it does not know, like the
 * loop-hook reply's contract (`hook-contract.ts`).
 */
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

export interface SessionEffectMessage {
	readonly message: {
		readonly customType: string;
		readonly content: string | (TextContent | ImageContent)[];
		readonly display: boolean;
		readonly details?: unknown;
	};
	readonly options?: {
		readonly triggerTurn?: boolean;
		readonly deliverAs?: "steer" | "followUp" | "nextTurn";
		readonly ticket?: string;
	};
}

export interface SessionEffectUserMessage {
	readonly content: string | (TextContent | ImageContent)[];
	readonly options?: { readonly deliverAs?: "steer" | "followUp"; readonly expandPromptTemplates?: boolean };
}

/** A change to the loop's active tool set relative to what the call carried; the loop applies it to its current set. */
export interface ActiveToolsChange {
	readonly activate: readonly string[];
	readonly deactivate: readonly string[];
}

export interface SessionEffects {
	readonly sent?: readonly SessionEffectMessage[];
	readonly notices?: readonly { readonly message: string; readonly type?: "info" | "warning" | "error" }[];
	readonly entries?: readonly { readonly customType: string; readonly data?: unknown }[];
	readonly userMessages?: readonly SessionEffectUserMessage[];
	readonly activeTools?: ActiveToolsChange;
	/** Late messages and notices the hand dropped past its per-session bound. */
	readonly droppedLate?: number;
}

/** A call's `sessionEffects` that are not exactly the closed shape. */
export class SessionEffectsContractError extends Error {
	override readonly name = "SessionEffectsContractError";
}

type Shape = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Shape =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function record(value: unknown, at: string, known: readonly string[]): Shape {
	if (!isRecord(value)) throw new SessionEffectsContractError(`${at} is not an object`);
	const unknown = Object.keys(value).filter((key) => !known.includes(key));
	if (unknown.length > 0) throw new SessionEffectsContractError(`${at} has unknown members: ${unknown.join(", ")}`);
	return value;
}

function list<T>(value: unknown, at: string, item: (entry: unknown, at: string) => T): T[] {
	if (!Array.isArray(value)) throw new SessionEffectsContractError(`${at} is not a list`);
	return value.map((entry, index) => item(entry, `${at}[${index}]`));
}

function text(value: unknown, at: string): string {
	if (typeof value !== "string" || value.length === 0) throw new SessionEffectsContractError(`${at} is not text`);
	return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], at: string): T | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
	throw new SessionEffectsContractError(`${at} is not one of ${allowed.join(", ")}`);
}

function flag(value: unknown, at: string): boolean | undefined {
	if (value === undefined || typeof value === "boolean") return value;
	throw new SessionEffectsContractError(`${at} is not a boolean`);
}

function content(value: unknown, at: string): string | (TextContent | ImageContent)[] {
	if (typeof value === "string") return value;
	return list(value, at, (part, partAt) => {
		const shape = record(part, partAt, ["type", "text", "data", "mimeType"]);
		if (shape.type === "text" && typeof shape.text === "string") return { type: "text", text: shape.text };
		if (shape.type === "image" && typeof shape.data === "string" && typeof shape.mimeType === "string")
			return { type: "image", data: shape.data, mimeType: shape.mimeType };
		throw new SessionEffectsContractError(`${partAt} is not text or image content`);
	});
}

function sentMessage(value: unknown, at: string): SessionEffectMessage {
	const shape = record(value, at, ["message", "options"]);
	const message = record(shape.message, `${at}.message`, ["customType", "content", "display", "details"]);
	const display = flag(message.display, `${at}.message.display`);
	if (display === undefined) throw new SessionEffectsContractError(`${at}.message.display is not a boolean`);
	const parsed: SessionEffectMessage["message"] = {
		customType: text(message.customType, `${at}.message.customType`),
		content: content(message.content, `${at}.message.content`),
		display,
		...(message.details === undefined ? {} : { details: message.details }),
	};
	if (shape.options === undefined) return { message: parsed };
	const options = record(shape.options, `${at}.options`, ["triggerTurn", "deliverAs", "ticket"]);
	const triggerTurn = flag(options.triggerTurn, `${at}.options.triggerTurn`);
	const deliverAs = oneOf(options.deliverAs, ["steer", "followUp", "nextTurn"] as const, `${at}.options.deliverAs`);
	const ticket = options.ticket === undefined ? undefined : text(options.ticket, `${at}.options.ticket`);
	return {
		message: parsed,
		options: {
			...(triggerTurn === undefined ? {} : { triggerTurn }),
			...(deliverAs === undefined ? {} : { deliverAs }),
			...(ticket === undefined ? {} : { ticket }),
		},
	};
}

function userMessage(value: unknown, at: string): SessionEffectUserMessage {
	const shape = record(value, at, ["content", "options"]);
	const parsedContent = content(shape.content, `${at}.content`);
	if (shape.options === undefined) return { content: parsedContent };
	const options = record(shape.options, `${at}.options`, ["deliverAs", "expandPromptTemplates"]);
	const deliverAs = oneOf(options.deliverAs, ["steer", "followUp"] as const, `${at}.options.deliverAs`);
	const expand = flag(options.expandPromptTemplates, `${at}.options.expandPromptTemplates`);
	return {
		content: parsedContent,
		options: {
			...(deliverAs === undefined ? {} : { deliverAs }),
			...(expand === undefined ? {} : { expandPromptTemplates: expand }),
		},
	};
}

function names(value: unknown, at: string): string[] {
	return list(value, at, text);
}

const KINDS = ["sent", "notices", "entries", "userMessages", "activeTools", "droppedLate"] as const;

/** Reads a call's `sessionEffects` as the closed shape; anything else is refused with a `SessionEffectsContractError`. */
export function parseSessionEffects(value: unknown): SessionEffects {
	const shape = record(value, "sessionEffects", KINDS);
	const { sent, notices, entries, userMessages, activeTools, droppedLate } = shape;
	if (
		droppedLate !== undefined &&
		!(typeof droppedLate === "number" && Number.isSafeInteger(droppedLate) && droppedLate >= 0)
	)
		throw new SessionEffectsContractError("sessionEffects.droppedLate is not a count");
	return {
		...(sent === undefined ? {} : { sent: list(sent, "sessionEffects.sent", sentMessage) }),
		...(notices === undefined
			? {}
			: {
					notices: list(notices, "sessionEffects.notices", (entry, at) => {
						const notice = record(entry, at, ["message", "type"]);
						const type = oneOf(notice.type, ["info", "warning", "error"] as const, `${at}.type`);
						return { message: text(notice.message, `${at}.message`), ...(type === undefined ? {} : { type }) };
					}),
				}),
		...(entries === undefined
			? {}
			: {
					entries: list(entries, "sessionEffects.entries", (entry, at) => {
						const appended = record(entry, at, ["customType", "data"]);
						const customType = text(appended.customType, `${at}.customType`);
						return appended.data === undefined ? { customType } : { customType, data: appended.data };
					}),
				}),
		...(userMessages === undefined
			? {}
			: { userMessages: list(userMessages, "sessionEffects.userMessages", userMessage) }),
		...(activeTools === undefined
			? {}
			: (() => {
					const change = record(activeTools, "sessionEffects.activeTools", ["activate", "deactivate"]);
					return {
						activeTools: {
							activate: names(change.activate, "sessionEffects.activeTools.activate"),
							deactivate: names(change.deactivate, "sessionEffects.activeTools.deactivate"),
						},
					};
				})()),
		...(droppedLate === undefined ? {} : { droppedLate }),
	};
}

/** The loop's active set after a call's change: its current set less what the call deactivated, plus what it activated. */
export function applyActiveToolsChange(current: readonly string[], change: ActiveToolsChange): string[] {
	const kept = current.filter((name) => !change.deactivate.includes(name));
	return [...kept, ...change.activate.filter((name) => !kept.includes(name))];
}
