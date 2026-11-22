// UTF-8 and base64 byte work without the Node `Buffer` global, so the tool cores also run on hosts that lack it.

const encoder = new TextEncoder();

/** Bytes `text` takes as UTF-8; a lone surrogate counts as its 3-byte replacement character, as `Buffer.byteLength` does. */
export function utf8ByteLength(text: string): number {
	let bytes = 0;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code < 0x80) bytes += 1;
		else if (code < 0x800) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
			const next = text.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				index++;
			} else bytes += 3;
		} else bytes += 3;
	}
	return bytes;
}

export function encodeUtf8(text: string): Uint8Array {
	return encoder.encode(text);
}

/** Decodes like `Buffer#toString("utf-8")`: invalid sequences become U+FFFD and a leading BOM is kept. */
export function decodeUtf8(bytes: Uint8Array): string {
	return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const joined = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		joined.set(chunk, offset);
		offset += chunk.length;
	}
	return joined;
}

const BASE64_CHUNK = 0x8000;

export function encodeBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let start = 0; start < bytes.length; start += BASE64_CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(start, start + BASE64_CHUNK));
	}
	return btoa(binary);
}

/** Decodes base64url text to UTF-8 like `Buffer.from(text, "base64url")`: a dangling final character is ignored. */
export function decodeBase64UrlUtf8(text: string): string {
	const usable = text.length % 4 === 1 ? text.slice(0, -1) : text;
	const base64 = usable.replaceAll("-", "+").replaceAll("_", "/");
	const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
	return decodeUtf8(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}
