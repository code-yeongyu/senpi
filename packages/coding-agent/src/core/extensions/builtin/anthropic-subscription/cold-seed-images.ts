import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/pi-ai";
import { isSdkImageMediaType } from "./content-blocks.ts";

/**
 * Most distinct historical images one cold-seed / flatten replay re-sends (#2490).
 * The user's own uploads are kept first, then the most recently returned tool
 * images; every other historical image becomes a one-line note. Every replayed
 * image is labeled as history in the turn that held it (#2768), so the model
 * does not read an earlier upload as attached to the new question. The final
 * user message is not history and always carries its own images.
 */
export const MAX_REPLAYED_HISTORY_IMAGES = 8;

export type ReplayedImageOrigin =
	| { readonly kind: "user" }
	| { readonly kind: "tool"; readonly toolName: string; readonly toolCallId: string };

function subject(origin: ReplayedImageOrigin): string {
	return origin.kind === "user" ? "[image attached by the user" : `[image returned by the ${origin.toolName} tool`;
}

function source(origin: ReplayedImageOrigin): string {
	return origin.kind === "user"
		? "attached by the user"
		: `returned by the ${origin.toolName} tool, id=${origin.toolCallId}`;
}

type ToolOrigin = Extract<ReplayedImageOrigin, { kind: "tool" }>;

export const coldSeedImageText = {
	/** Every tool image in the history, pending or answered, so its bytes never change when its turn ends (#5275). */
	toolImage: (origin: ToolOrigin): string =>
		`[image returned by the ${origin.toolName} tool, id=${origin.toolCallId} (tool output, not a user attachment): not shown in the history; an image from your current turn is attached after the history, any other was already seen, so run the tool again if you need it]`,
	currentTurnToolOutput: (origin: ToolOrigin): string =>
		`[image returned by the ${origin.toolName} tool, id=${origin.toolCallId}, to your own call in the current turn (tool output, not a user attachment)]`,
	userHistory: "[image the user attached to this message of the history (not part of any newer message)]",
	duplicate: (origin: ReplayedImageOrigin, first: ReplayedImageOrigin): string =>
		`${subject(origin)}: identical to an image already shown above (${source(first)}); not attached again]`,
	capped: (origin: ReplayedImageOrigin): string =>
		`${subject(origin)}: omitted from this replay, which re-sends at most ${MAX_REPLAYED_HISTORY_IMAGES} earlier images; re-read the source if you need it]`,
	unreadable: (origin: ReplayedImageOrigin): string =>
		`${subject(origin)}: omitted because its image data is missing or unreadable]`,
} as const;

type ImageOccurrence = {
	readonly messageIndex: number;
	/** A later assistant message already responded to this image. */
	readonly answered: boolean;
	readonly entryIndex: number;
	readonly origin: ReplayedImageOrigin;
	readonly entry: Record<string, unknown>;
	readonly decoded: DecodedImage | undefined;
};

type DecodedImage = { readonly sha256: string; readonly compactBase64: string };

// Standard or URL-safe alphabet, padding optional; line wrapping is stripped first.
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

function decodeImageData(data: string): DecodedImage | undefined {
	const compact = data.replace(/\s+/g, "");
	if (compact.length === 0 || compact.replace(/=+$/, "").length % 4 === 1 || !BASE64.test(compact)) return undefined;
	return { sha256: createHash("sha256").update(Buffer.from(compact, "base64")).digest("hex"), compactBase64: compact };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function originOf(
	message: Extract<Context["messages"][number], { role: "user" | "toolResult" }>,
	sdkToolName: (piToolName: string) => string,
): ReplayedImageOrigin {
	return message.role === "user"
		? { kind: "user" }
		: { kind: "tool", toolName: sdkToolName(message.toolName), toolCallId: message.toolCallId };
}

function imageBearingContent(
	history: Context["messages"],
	sdkToolName: (piToolName: string) => string,
): Map<number, { readonly origin: ReplayedImageOrigin; readonly content: readonly unknown[] }> {
	const contents = new Map<number, { readonly origin: ReplayedImageOrigin; readonly content: readonly unknown[] }>();
	history.forEach((message, messageIndex) => {
		if (message.role !== "user" && message.role !== "toolResult") return;
		if (typeof message.content === "string") return;
		contents.set(messageIndex, { origin: originOf(message, sdkToolName), content: message.content });
	});
	return contents;
}

function collectOccurrences(
	contents: ReadonlyMap<number, { readonly origin: ReplayedImageOrigin; readonly content: readonly unknown[] }>,
	lastAssistantIndex: number,
): ImageOccurrence[] {
	const occurrences: ImageOccurrence[] = [];
	for (const [messageIndex, { origin, content }] of contents) {
		const answered = messageIndex < lastAssistantIndex;
		content.forEach((entry, entryIndex) => {
			// Entries without string data or with an unsupported media type keep the
			// shared mapper's own placeholder (content-blocks.ts), as before.
			if (!isRecord(entry) || entry.type !== "image") return;
			if (typeof entry.data !== "string" || typeof entry.mimeType !== "string") return;
			if (!isSdkImageMediaType(entry.mimeType)) return;
			occurrences.push({ messageIndex, answered, entryIndex, origin, entry, decoded: decodeImageData(entry.data) });
		});
	}
	return occurrences;
}

/**
 * Past `MAX_REPLAYED_HISTORY_IMAGES` distinct user uploads, the oldest ones are dropped in blocks of this many, so the
 * history (where uploads are replayed in place) changes once per this many new uploads instead of on every one
 * (senpi#2988 item 3). Between 8 - 4 + 1 = 5 and 8 of the newest uploads stay replayed.
 */
export const REPLAYED_UPLOAD_DROP_STEP = 4;

function droppedUploadCount(entries: number): number {
	const over = entries - MAX_REPLAYED_HISTORY_IMAGES;
	return over <= 0 ? 0 : Math.ceil(over / REPLAYED_UPLOAD_DROP_STEP) * REPLAYED_UPLOAD_DROP_STEP;
}

type ReplaySelection = {
	/** User-upload occurrences replayed in place. */
	readonly uploads: ReadonlySet<ImageOccurrence>;
	readonly currentTurnTools: ReadonlySet<string>;
};

/**
 * The user's uploads come first, as a list of entries in order of appearance; past the cap the oldest entries are
 * dropped in steps. Dropping only ever grows, so an entry's decision never changes once made. A re-upload of an image
 * whose entry was already dropped when it arrived opens a new entry at the end instead of inheriting the old decision.
 * The current turn's tool images fill the remaining slots, most recent first; they are sent after the cache breakpoint,
 * so that choice may change every request.
 */
function selectUserFirstThenMostRecent(occurrences: readonly ImageOccurrence[]): ReplaySelection {
	const entryHashes: string[] = [];
	const entryOfHash = new Map<string, number>();
	const entryOf = new Map<ImageOccurrence, number>();
	const toolLastSeen = new Map<string, number>();
	occurrences.forEach((occurrence, order) => {
		const hash = occurrence.decoded?.sha256;
		if (hash === undefined || isAnsweredToolImage(occurrence)) return;
		if (occurrence.origin.kind !== "user") {
			toolLastSeen.set(hash, order);
			return;
		}
		let entry = entryOfHash.get(hash);
		if (entry === undefined || entry < droppedUploadCount(entryHashes.length)) {
			entry = entryHashes.push(hash) - 1;
			entryOfHash.set(hash, entry);
		}
		entryOf.set(occurrence, entry);
	});
	const firstKept = droppedUploadCount(entryHashes.length);
	const keptHashes = new Set(entryHashes.slice(firstKept));
	const uploads = new Set([...entryOf].filter(([, entry]) => entry >= firstKept).map(([occurrence]) => occurrence));
	// A current-turn tool image whose bytes match a dropped upload takes a free slot without making that upload's
	// history entry replayable again, which would rewrite the cached history.
	const tools = [...toolLastSeen.entries()]
		.filter(([hash]) => !keptHashes.has(hash))
		.sort(([, x], [, y]) => y - x)
		.slice(0, MAX_REPLAYED_HISTORY_IMAGES - keptHashes.size)
		.map(([hash]) => hash);
	return { uploads, currentTurnTools: new Set([...keptHashes, ...tools]) };
}

/**
 * A tool image the assistant already responded to is not re-sent (#2768): a cold
 * seed packs the whole history into one user message, and replaying earlier tool
 * reads there made the model answer plain questions as if the user had just sent
 * those images. The user's own uploads and images still awaiting a response are
 * replayed.
 */
function isAnsweredToolImage(occurrence: ImageOccurrence): boolean {
	return occurrence.answered && occurrence.origin.kind === "tool";
}

export type ReplayedHistoryImages = {
	/** Replacement content for each history index that holds an image; every other message is replayed unchanged. */
	readonly history: ReadonlyMap<number, readonly unknown[]>;
	/** The current turn's tool images, sent after the history and its cache breakpoint. */
	readonly currentTurn: readonly unknown[];
};

/**
 * Rewrites the image entries of a cold-seed history (#2490): identical bytes are sent once and referenced in text
 * afterwards, the replay is capped, and undecodable image data is dropped with a note.
 *
 * What a history entry becomes depends only on the history before it, never on whether a later assistant message
 * answered it, so a request rebuilt after the turn ends starts with the bytes the previous one cached (#5275). A tool
 * image is therefore always a text note in the history; while its turn is in progress it is also sent in
 * `currentTurn`, which comes after the cache breakpoint and simply disappears when the turn ends (#2768: an answered
 * tool image is never re-sent). A user upload is replayed in place under the same label in every state.
 */
export function replayHistoryImages(
	history: Context["messages"],
	sdkToolName: (piToolName: string) => string,
	options: { readonly inProgressTurn?: boolean } = {},
): ReplayedHistoryImages {
	const contents = imageBearingContent(history, sdkToolName);
	// Everything before this index is from turns the assistant already finished. A replay taken in
	// the middle of a turn keeps that turn's own user message and tool results in history; they are
	// the work in progress, not the past.
	const answeredBefore = options.inProgressTurn
		? Math.max(
				0,
				history.findLastIndex((message) => message.role === "user"),
			)
		: history.findLastIndex((message) => message.role === "assistant");
	const occurrences = collectOccurrences(contents, answeredBefore);
	if (occurrences.length === 0) return { history: new Map(), currentTurn: [] };
	const replayed = selectUserFirstThenMostRecent(occurrences);
	const shownInHistory = new Map<string, ReplayedImageOrigin>();
	const shownInCurrentTurn = new Map<string, ReplayedImageOrigin>();
	const replacements = new Map<number, Map<number, readonly unknown[]>>();
	const currentTurn: unknown[] = [];
	const canonical = (entry: Record<string, unknown>, decoded: DecodedImage): Record<string, unknown> => ({
		...entry,
		data: Buffer.from(decoded.compactBase64, "base64").toString("base64"),
	});

	for (const occurrence of occurrences) {
		const { origin, entry, decoded } = occurrence;
		const hash = decoded?.sha256;
		const shownEarlier = hash === undefined ? undefined : shownInHistory.get(hash);
		let replacement: readonly unknown[];
		if (decoded === undefined || hash === undefined) {
			replacement = [{ type: "text", text: coldSeedImageText.unreadable(origin) }];
		} else if (shownEarlier !== undefined) {
			replacement = [{ type: "text", text: coldSeedImageText.duplicate(origin, shownEarlier) }];
		} else if (origin.kind === "tool") {
			replacement = [{ type: "text", text: coldSeedImageText.toolImage(origin) }];
			if (!occurrence.answered) {
				const first = shownInCurrentTurn.get(hash);
				if (first !== undefined) {
					currentTurn.push({ type: "text", text: coldSeedImageText.duplicate(origin, first) });
				} else if (!replayed.currentTurnTools.has(hash)) {
					currentTurn.push({ type: "text", text: coldSeedImageText.capped(origin) });
				} else {
					shownInCurrentTurn.set(hash, origin);
					currentTurn.push(
						{ type: "text", text: coldSeedImageText.currentTurnToolOutput(origin) },
						canonical(entry, decoded),
					);
				}
			}
		} else if (!replayed.uploads.has(occurrence)) {
			replacement = [{ type: "text", text: coldSeedImageText.capped(origin) }];
		} else {
			shownInHistory.set(hash, origin);
			replacement = [{ type: "text", text: coldSeedImageText.userHistory }, canonical(entry, decoded)];
		}
		const perMessage = replacements.get(occurrence.messageIndex) ?? new Map<number, readonly unknown[]>();
		perMessage.set(occurrence.entryIndex, replacement);
		replacements.set(occurrence.messageIndex, perMessage);
	}

	const rewritten = new Map<number, readonly unknown[]>();
	for (const [messageIndex, perMessage] of replacements) {
		const content = contents.get(messageIndex)?.content ?? [];
		rewritten.set(
			messageIndex,
			content.flatMap((entry, entryIndex) => perMessage.get(entryIndex) ?? [entry]),
		);
	}
	return { history: rewritten, currentTurn };
}
