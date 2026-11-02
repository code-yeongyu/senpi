import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentToolResult } from "@code-yeongyu/senpi";
import type { EvalToolDetails } from "./types.ts";

export type SettledContentPart = AgentToolResult<EvalToolDetails>["content"][number];

export interface SpilledImageRef {
	readonly type: "spilled-image";
	readonly path: string;
	readonly mimeType: string;
	readonly length: number;
}

export type RetainedContentPart = SettledContentPart | SpilledImageRef;

export interface SettledImageSpillOptions {
	readonly dir: string;
	/** Upper bound on the spilled base64 bytes on disk; 0 keeps only the snapshot count cap. */
	readonly byteBudget: number;
}

/**
 * Keeps settled-cell image payloads on disk instead of the session heap (#2259). Each image is one raw
 * base64 file; the oldest files go first beyond the byte budget (never the newest cell's), a snapshot's
 * files go with it, and the whole directory goes on dispose.
 */
export class SettledImageSpill {
	readonly #dir: string;
	readonly #byteBudget: number;
	readonly #files = new Map<string, { readonly cellId: string; readonly bytes: number }>();
	#bytes = 0;
	#sequence = 0;

	constructor(options: SettledImageSpillOptions) {
		this.#dir = options.dir;
		this.#byteBudget = options.byteBudget;
	}

	get bytes(): number {
		return this.#bytes;
	}

	spill(cellId: string, content: readonly SettledContentPart[]): readonly RetainedContentPart[] {
		if (!content.some((part) => part.type === "image")) return content;
		mkdirSync(this.#dir, { recursive: true });
		const retained = content.map((part) => (part.type === "image" ? this.#write(cellId, part) : part));
		this.#enforceBudget(cellId);
		return retained;
	}

	hydrate(parts: readonly RetainedContentPart[]): SettledContentPart[] {
		return parts.map((part) => (part.type === "spilled-image" ? readSpilledImage(part) : part));
	}

	release(parts: readonly RetainedContentPart[]): void {
		for (const part of parts) if (part.type === "spilled-image") this.#remove(part.path);
	}

	clear(): void {
		rmSync(this.#dir, { recursive: true, force: true });
		this.#files.clear();
		this.#bytes = 0;
	}

	#write(cellId: string, image: Extract<SettledContentPart, { type: "image" }>): RetainedContentPart {
		this.#sequence += 1;
		const path = join(this.#dir, `${cellId.replace(/[^a-zA-Z0-9_-]/gu, "_")}-${this.#sequence}.b64`);
		try {
			writeFileSync(path, image.data, "latin1");
		} catch (error) {
			// A full or read-only disk keeps this image inline, where the in-memory byte budget bounds it.
			if (error instanceof Error && "code" in error) return image;
			throw error;
		}
		this.#files.set(path, { cellId, bytes: image.data.length });
		this.#bytes += image.data.length;
		return { type: "spilled-image", path, mimeType: image.mimeType, length: image.data.length };
	}

	#enforceBudget(newestCellId: string): void {
		if (this.#byteBudget <= 0) return;
		for (const [path, file] of this.#files) {
			if (this.#bytes <= this.#byteBudget) return;
			if (file.cellId !== newestCellId) this.#remove(path);
		}
	}

	#remove(path: string): void {
		const file = this.#files.get(path);
		if (file === undefined) return;
		this.#files.delete(path);
		this.#bytes -= file.bytes;
		rmSync(path, { force: true });
	}
}

function readSpilledImage(ref: SpilledImageRef): SettledContentPart {
	try {
		return { type: "image", mimeType: ref.mimeType, data: readFileSync(ref.path, "latin1") };
	} catch (error) {
		const reason = error instanceof Error && "code" in error ? String(error.code) : String(error);
		return {
			type: "text",
			text: `[${ref.mimeType} image (${ref.length} base64 bytes) of this settled cell is no longer available: ${ref.path} (${reason})]`,
		};
	}
}
