/**
 * The closed shapes of the session state a hand call reads and changes beside the transcript (senpi#6754): the
 * session's documents (the files extensions keep in its session directory), its durable wakes, and a move request.
 * Shared by the loop's parser of a call's writes (`session-effects.ts`) and the hand's parser of what a call carries.
 */
import { isAbsolute, normalize, sep } from "node:path";
import type { SessionWake, SessionWakeChange, SessionWakeEntry } from "../session-wakes.ts";

/** A document path names a file inside the session directory: relative, normalized, with no `..` step. */
export function isDocumentPath(path: string): boolean {
	if (path.length === 0 || isAbsolute(path)) return false;
	const normalized = normalize(path);
	return normalized === path.split("/").join(sep) && !normalized.split(sep).includes("..");
}

export class SessionStateContractError extends Error {
	override readonly name = "SessionStateContractError";
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function closed(value: unknown, at: string, known: readonly string[]): Readonly<Record<string, unknown>> {
	if (!isRecord(value)) throw new SessionStateContractError(`${at} is not an object`);
	const unknown = Object.keys(value).filter((key) => !known.includes(key));
	if (unknown.length > 0) throw new SessionStateContractError(`${at} has unknown members: ${unknown.join(", ")}`);
	return value;
}

const nonEmpty = (value: unknown, at: string): string => {
	if (typeof value !== "string" || value.length === 0) throw new SessionStateContractError(`${at} is not text`);
	return value;
};

const epoch = (value: unknown, at: string): number => {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new SessionStateContractError(`${at} is not a time`);
	return value;
};

/** Documents keyed by path; `removable` admits `null` (a removed document, in a call's changes). */
export function parseDocuments(value: unknown, at: string, removable: true): Record<string, string | null>;
export function parseDocuments(value: unknown, at: string, removable: false): Record<string, string>;
export function parseDocuments(value: unknown, at: string, removable: boolean): Record<string, string | null> {
	if (!isRecord(value)) throw new SessionStateContractError(`${at} is not an object`);
	const documents: Record<string, string | null> = {};
	for (const [path, text] of Object.entries(value)) {
		if (!isDocumentPath(path)) throw new SessionStateContractError(`${at} names a path outside the session: ${path}`);
		if (typeof text === "string" || (removable && text === null)) documents[path] = text;
		else throw new SessionStateContractError(`${at}[${path}] is not a document`);
	}
	return documents;
}

function parseWakeEntry(value: unknown, at: string): SessionWakeEntry {
	const entry = closed(value, at, ["customType", "data"]);
	const customType = nonEmpty(entry.customType, `${at}.customType`);
	return entry.data === undefined ? { customType } : { customType, data: entry.data };
}

/** One wake: the schedule and what to run, and nothing else (no key material has a place in it). */
export function parseWake(value: unknown, at: string): SessionWake {
	const wake = closed(value, at, ["id", "source", "dueAt", "everyMs", "prompt", "createdAt", "entry"]);
	if (wake.source !== "schedule_prompt" && wake.source !== "schedule_wakeup")
		throw new SessionStateContractError(`${at}.source is not a scheduling tool`);
	const everyMs = wake.everyMs === undefined ? undefined : epoch(wake.everyMs, `${at}.everyMs`);
	return {
		id: nonEmpty(wake.id, `${at}.id`),
		source: wake.source,
		dueAt: epoch(wake.dueAt, `${at}.dueAt`),
		...(everyMs === undefined ? {} : { everyMs }),
		prompt: nonEmpty(wake.prompt, `${at}.prompt`),
		createdAt: epoch(wake.createdAt, `${at}.createdAt`),
		...(wake.entry === undefined ? {} : { entry: parseWakeEntry(wake.entry, `${at}.entry`) }),
	};
}

export function parseWakes(value: unknown, at: string): SessionWake[] {
	if (!Array.isArray(value)) throw new SessionStateContractError(`${at} is not a list`);
	return value.map((wake, index) => parseWake(wake, `${at}[${index}]`));
}

export function parseWakeChanges(value: unknown, at: string): SessionWakeChange[] {
	if (!Array.isArray(value)) throw new SessionStateContractError(`${at} is not a list`);
	return value.map((change, index): SessionWakeChange => {
		const changeAt = `${at}[${index}]`;
		if (isRecord(change) && change.op === "arm") {
			const arm = closed(change, changeAt, ["op", "wake"]);
			return { op: "arm", wake: parseWake(arm.wake, `${changeAt}.wake`) };
		}
		const cancel = closed(change, changeAt, ["op", "id"]);
		if (cancel.op !== "cancel") throw new SessionStateContractError(`${changeAt}.op is not arm or cancel`);
		return { op: "cancel", id: nonEmpty(cancel.id, `${changeAt}.id`) };
	});
}

export interface RelocationRequestEffect {
	readonly target: string;
	readonly reason: string;
	readonly moveId: string;
}

export function parseRelocationRequest(value: unknown, at: string): RelocationRequestEffect {
	const request = closed(value, at, ["target", "reason", "moveId"]);
	return {
		target: nonEmpty(request.target, `${at}.target`),
		reason: nonEmpty(request.reason, `${at}.reason`),
		moveId: nonEmpty(request.moveId, `${at}.moveId`),
	};
}
