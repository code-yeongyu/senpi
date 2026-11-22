import { open } from "node:fs/promises";
import { detectSupportedImageMimeType, IMAGE_TYPE_SNIFF_BYTES } from "./image-mime.ts";

export { detectSupportedImageMimeType } from "./image-mime.ts";

export async function detectSupportedImageMimeTypeFromFile(filePath: string): Promise<string | null> {
	const fileHandle = await open(filePath, "r");
	try {
		const buffer = Buffer.alloc(IMAGE_TYPE_SNIFF_BYTES);
		const { bytesRead } = await fileHandle.read(buffer, 0, IMAGE_TYPE_SNIFF_BYTES, 0);
		return detectSupportedImageMimeType(buffer.subarray(0, bytesRead));
	} finally {
		await fileHandle.close();
	}
}
