/**
 * The image bytes behind a pending input's attachment fingerprints (senpi#3549 P2c). The journal names each
 * attachment by `mimeType:sha256`; this store keeps the bytes under that name next to the session file, so a
 * reopen can rebuild a queued input from the store alone.
 *
 * Crash order: a blob is written and synced (file and directory) before the record that names it is appended,
 * so a record never points at a blob that was never durable. A blob stays while any queued or sending input
 * names it and is removed once none does.
 */
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";

export function attachmentFingerprint(image: ImageContent): string {
	return `${image.mimeType}:${createHash("sha256").update(image.data).digest("hex")}`;
}

export interface LoadedAttachments {
	readonly images: ImageContent[];
	/** Fingerprints whose bytes were not found: the input's text survives, its images do not. */
	readonly missing: readonly string[];
}

export class PendingInputAttachments {
	private readonly dir: () => string | undefined;
	private readonly syncDirectory: boolean;

	constructor(options: { readonly dir: () => string | undefined; readonly platform?: NodeJS.Platform }) {
		this.dir = options.dir;
		// Windows cannot open a directory for fsync; its rename is durable once the file is synced.
		this.syncDirectory = (options.platform ?? process.platform) !== "win32";
	}

	/** Makes every image durable under its fingerprint; resolves only after the bytes are synced. */
	save(images: readonly ImageContent[]): void {
		const dir = this.dir();
		if (dir === undefined || images.length === 0) return;
		mkdirSync(dir, { recursive: true });
		let wrote = false;
		for (const image of images) {
			const file = join(dir, blobName(attachmentFingerprint(image)));
			if (existsSync(file)) continue;
			const partial = `${file}.${process.pid}.partial`;
			const fd = openSync(partial, "w");
			try {
				writeSync(fd, JSON.stringify({ mimeType: image.mimeType, data: image.data }));
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			renameSync(partial, file);
			wrote = true;
		}
		if (wrote && this.syncDirectory) {
			const fd = openSync(dir, "r");
			try {
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
		}
	}

	load(fingerprints: readonly string[]): LoadedAttachments {
		const dir = this.dir();
		const images: ImageContent[] = [];
		const missing: string[] = [];
		for (const fingerprint of fingerprints) {
			const image = dir === undefined ? undefined : readBlob(join(dir, blobName(fingerprint)), fingerprint);
			if (image === undefined) missing.push(fingerprint);
			else images.push(image);
		}
		return { images, missing };
	}

	prune(referenced: ReadonlySet<string>): void {
		const dir = this.dir();
		if (dir === undefined || !existsSync(dir)) return;
		const keep = new Set([...referenced].map(blobName));
		for (const name of readdirSync(dir)) {
			if (name.endsWith(".blob") && !keep.has(name)) rmSync(join(dir, name), { force: true });
		}
	}
}

function blobName(fingerprint: string): string {
	return `${createHash("sha256").update(fingerprint).digest("hex")}.blob`;
}

function readBlob(file: string, fingerprint: string): ImageContent | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			!("mimeType" in parsed && typeof parsed.mimeType === "string") ||
			!("data" in parsed && typeof parsed.data === "string")
		)
			return undefined;
		const image: ImageContent = { type: "image", mimeType: parsed.mimeType, data: parsed.data };
		// A blob whose bytes do not hash to its name is not this attachment.
		return attachmentFingerprint(image) === fingerprint ? image : undefined;
	} catch {
		return undefined;
	}
}
