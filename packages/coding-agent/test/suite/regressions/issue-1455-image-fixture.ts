import { crc32, deflateSync } from "node:zlib";
import type { ImageContent } from "@earendil-works/pi-ai";

function pngChunk(type: string, data: Buffer): Buffer {
	const name = Buffer.from(type);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
	return Buffer.concat([length, name, data, checksum]);
}

/** A valid, deterministic PNG with a realistic payload; no screenshots or credentials. */
export function createCompactionImage(): ImageContent {
	const width = 512;
	const pixels = Buffer.alloc((width * 4 + 1) * width);
	let seed = 1;
	for (let y = 0; y < width; y++) {
		for (let x = 1; x <= width * 4; x++) {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			pixels[y * (width * 4 + 1) + x] = seed >>> 24;
		}
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(width, 4);
	header[8] = 8;
	header[9] = 6;
	const png = Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(pixels)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
	return { type: "image", mimeType: "image/png", data: png.toString("base64") };
}
