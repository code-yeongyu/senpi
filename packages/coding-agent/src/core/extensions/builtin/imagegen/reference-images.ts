import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai/compat";

const MAX_REFERENCE_BYTES = 50 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const RIFF_SIGNATURE = Buffer.from("RIFF");
const WEBP_SIGNATURE = Buffer.from("WEBP");

type ReferenceImages = { ok: true; images: ImageContent[] } | { ok: false; error: string };

function imageMimeType(bytes: Buffer): string | undefined {
	if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
	if (bytes.subarray(0, 3).equals(JPEG_SIGNATURE)) return "image/jpeg";
	if (bytes.subarray(0, 4).equals(RIFF_SIGNATURE) && bytes.subarray(8, 12).equals(WEBP_SIGNATURE)) {
		return "image/webp";
	}
	return undefined;
}

export async function loadReferenceImages(cwd: string, paths: string[] | undefined): Promise<ReferenceImages> {
	if (paths === undefined) return { ok: true, images: [] };
	if (paths.length < 1 || paths.length > 5) {
		return { ok: false, error: `Error: reference_image_paths must contain 1 to 5 paths (got ${paths.length}).` };
	}
	const images: ImageContent[] = [];
	for (const path of paths) {
		try {
			// Nonblocking open lets us reject FIFOs without waiting for a writer.
			const file = await open(resolve(cwd, path), constants.O_RDONLY | constants.O_NONBLOCK);
			try {
				const stat = await file.stat();
				if (!stat.isFile()) throw new Error("must be a regular file");
				if (stat.size > MAX_REFERENCE_BYTES) throw new Error("must be at most 50 MB");
				const bytes = await file.readFile();
				if (bytes.length > MAX_REFERENCE_BYTES) throw new Error("must be at most 50 MB");
				const mimeType = imageMimeType(bytes);
				if (mimeType === undefined) throw new Error("must be a PNG, JPEG, or WEBP image (invalid magic bytes)");
				images.push({ type: "image", data: bytes.toString("base64"), mimeType });
			} finally {
				await file.close();
			}
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return { ok: false, error: `Error: reference image "${path}": ${reason}` };
		}
	}
	return { ok: true, images };
}
