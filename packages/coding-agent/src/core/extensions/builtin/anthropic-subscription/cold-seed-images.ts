import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/pi-ai";
import { isSdkImageMediaType } from "./content-blocks.ts";

/**
 * Most distinct historical images one cold-seed / flatten replay re-sends (#2490).
 * The user's own uploads are kept first, then the most recently returned tool
 * images; every other historical image becomes a one-line note. The final user
 * message is not history and always carries its own images.
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

export const coldSeedImageText = {
	toolOutput: (toolName: string): string =>
		`[image returned by the ${toolName} tool (tool output, not a user attachment)]`,
	duplicate: (origin: ReplayedImageOrigin, first: ReplayedImageOrigin): string =>
		`${subject(origin)}: identical to an image already shown above (${source(first)}); not attached again]`,
	capped: (origin: ReplayedImageOrigin): string =>
		`${subject(origin)}: omitted from this replay, which re-sends at most ${MAX_REPLAYED_HISTORY_IMAGES} earlier images; re-read the source if you need it]`,
	unreadable: (origin: ReplayedImageOrigin): string =>
		`${subject(origin)}: omitted because its image data is missing or unreadable]`,
} as const;

type ImageOccurrence = {
	readonly messageIndex: number;
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
): ImageOccurrence[] {
	const occurrences: ImageOccurrence[] = [];
	for (const [messageIndex, { origin, content }] of contents) {
		content.forEach((entry, entryIndex) => {
			// Entries without string data or with an unsupported media type keep the
			// shared mapper's own placeholder (content-blocks.ts), as before.
			if (!isRecord(entry) || entry.type !== "image") return;
			if (typeof entry.data !== "string" || typeof entry.mimeType !== "string") return;
			if (!isSdkImageMediaType(entry.mimeType)) return;
			occurrences.push({ messageIndex, entryIndex, origin, entry, decoded: decodeImageData(entry.data) });
		});
	}
	return occurrences;
}

function selectUserFirstThenMostRecent(occurrences: readonly ImageOccurrence[]): ReadonlySet<string> {
	const ranked = new Map<string, { fromUser: boolean; lastSeen: number }>();
	occurrences.forEach((occurrence, order) => {
		const hash = occurrence.decoded?.sha256;
		if (hash === undefined) return;
		const previous = ranked.get(hash);
		ranked.set(hash, {
			fromUser: (previous?.fromUser ?? false) || occurrence.origin.kind === "user",
			lastSeen: order,
		});
	});
	const ordered = [...ranked.entries()].sort(
		([, a], [, b]) => Number(b.fromUser) - Number(a.fromUser) || b.lastSeen - a.lastSeen,
	);
	return new Set(ordered.slice(0, MAX_REPLAYED_HISTORY_IMAGES).map(([hash]) => hash));
}

/**
 * Rewrites the image entries of a cold-seed history (#2490): a tool-result image
 * is labeled as tool output, identical bytes are sent once and referenced in text
 * afterwards, the replay is capped, and undecodable image data is dropped with a
 * note. Returns the replacement content for each history index that holds an
 * image; every other message is replayed unchanged.
 */
export function replayHistoryImages(
	history: Context["messages"],
	sdkToolName: (piToolName: string) => string,
): ReadonlyMap<number, readonly unknown[]> {
	const contents = imageBearingContent(history, sdkToolName);
	const occurrences = collectOccurrences(contents);
	if (occurrences.length === 0) return new Map();
	const replayed = selectUserFirstThenMostRecent(occurrences);
	const firstShown = new Map<string, ReplayedImageOrigin>();
	const replacements = new Map<number, Map<number, readonly unknown[]>>();

	for (const occurrence of occurrences) {
		const { origin, entry, decoded } = occurrence;
		const hash = decoded?.sha256;
		let replacement: readonly unknown[];
		if (decoded === undefined || hash === undefined) {
			replacement = [{ type: "text", text: coldSeedImageText.unreadable(origin) }];
		} else if (!replayed.has(hash)) {
			replacement = [{ type: "text", text: coldSeedImageText.capped(origin) }];
		} else {
			const first = firstShown.get(hash);
			if (first) {
				replacement = [{ type: "text", text: coldSeedImageText.duplicate(origin, first) }];
			} else {
				firstShown.set(hash, origin);
				const canonical = { ...entry, data: Buffer.from(decoded.compactBase64, "base64").toString("base64") };
				replacement =
					origin.kind === "tool"
						? [{ type: "text", text: coldSeedImageText.toolOutput(origin.toolName) }, canonical]
						: [canonical];
			}
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
	return rewritten;
}
