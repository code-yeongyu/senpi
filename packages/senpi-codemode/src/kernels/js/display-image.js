const BASE64_STRICT_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const DECIMAL_CSV_RE = /^\d{1,3}(?:,\d{1,3})*$/u;
const DATA_URL_RE = /^data:([^;,]+)(?:;[^,]*)?;base64,([\s\S]*)$/u;

const IMAGE_SIGNATURES = [
	{ mimeType: "image/png", offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
	{ mimeType: "image/jpeg", offset: 0, bytes: [0xff, 0xd8, 0xff] },
	{ mimeType: "image/gif", offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] },
	{ mimeType: "image/webp", offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
	{ mimeType: "image/bmp", offset: 0, bytes: [0x42, 0x4d] },
];

export function sniffImageMimeType(bytes) {
	for (const signature of IMAGE_SIGNATURES) {
		if (bytes.length < signature.offset + signature.bytes.length) continue;
		if (signature.bytes.every((byte, index) => bytes[signature.offset + index] === byte)) return signature.mimeType;
	}
	return undefined;
}

export function isBinaryData(value) {
	return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function bytesOf(value) {
	if (value instanceof Uint8Array) return value;
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	return undefined;
}

function normalizeBase64(text) {
	const compact = text.replace(/\s+/gu, "").replace(/-/gu, "+").replace(/_/gu, "/");
	const padded = compact.length % 4 === 0 ? compact : `${compact}${"=".repeat(4 - (compact.length % 4))}`;
	return padded.length > 0 && BASE64_STRICT_RE.test(padded) ? padded : undefined;
}

function decimalCsvBase64(text) {
	const parts = text.split(",");
	const bytes = new Uint8Array(parts.length);
	for (let index = 0; index < parts.length; index += 1) {
		const byte = Number(parts[index]);
		if (!Number.isInteger(byte) || byte < 0 || byte > 255) return undefined;
		bytes[index] = byte;
	}
	return Buffer.from(bytes).toString("base64");
}

function serializedBufferBase64(data) {
	const bytes = new Uint8Array(data.length);
	for (let index = 0; index < data.length; index += 1) {
		const byte = data[index];
		if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) return undefined;
		bytes[index] = byte;
	}
	return Buffer.from(bytes).toString("base64");
}

export function imagePayload(data) {
	if (typeof data === "string") {
		const dataUrl = DATA_URL_RE.exec(data);
		if (dataUrl) {
			const dataBase64 = normalizeBase64(dataUrl[2]);
			return dataBase64 === undefined ? undefined : { dataBase64, mimeType: dataUrl[1] };
		}
		const dataBase64 = normalizeBase64(data);
		if (dataBase64 !== undefined) return { dataBase64 };
		return DECIMAL_CSV_RE.test(data) ? wrap(decimalCsvBase64(data)) : undefined;
	}
	const bytes = bytesOf(data);
	if (bytes !== undefined) return { dataBase64: Buffer.from(bytes).toString("base64"), mimeType: sniffImageMimeType(bytes) };
	if (isSerializedBuffer(data)) return wrap(serializedBufferBase64(data.data));
	return undefined;
}

function wrap(dataBase64) {
	return dataBase64 === undefined ? undefined : { dataBase64 };
}

function isSerializedBuffer(data) {
	return (
		typeof data === "object" &&
		data !== null &&
		Object.getPrototypeOf(data) === Object.prototype &&
		data.type === "Buffer" &&
		Array.isArray(data.data)
	);
}

function describeImageData(data) {
	if (data === null) return "null";
	if (data instanceof Uint8Array) return "Uint8Array";
	if (data instanceof ArrayBuffer) return "ArrayBuffer";
	if (ArrayBuffer.isView(data)) return data.constructor.name;
	if (typeof data === "string") return `string(${data.length})`;
	return typeof data;
}

function isImageFrame(value) {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof value.mimeType === "string" &&
		typeof value.dataBase64 === "string"
	);
}

function isMarshalledToolResult(value) {
	return typeof value.text === "string" && Array.isArray(value.images) && value.images.every(isImageFrame);
}

function isEncodableImage(value) {
	return !isBinaryData(value) && (typeof value.arrayBuffer === "function" || typeof value.bytes === "function");
}

function frame(mimeType, dataBase64) {
	return { kind: "frame", mimeType, dataBase64 };
}

function dropped(reason) {
	return [{ kind: "text", text: `[display: image dropped — ${reason}]` }];
}

export function resolveDisplayOps(value) {
	if (typeof value !== "object" || value === null) return undefined;
	if (value.type === "image" && typeof value.mimeType === "string") {
		const payload = imagePayload(value.data);
		return payload === undefined
			? dropped(
					`\`data\` must be a base64 string, data: URL, Uint8Array/Buffer, or ArrayBuffer; got ${describeImageData(value.data)}`,
				)
			: [frame(value.mimeType, payload.dataBase64)];
	}
	if (isImageFrame(value)) return [frame(value.mimeType, value.dataBase64)];
	if (isMarshalledToolResult(value)) {
		const frames = value.images.map((image) => frame(image.mimeType, image.dataBase64));
		return value.text === "" ? frames : [{ kind: "text", text: value.text }, ...frames];
	}
	if (isBinaryData(value)) {
		const payload = imagePayload(value);
		return [frame(payload.mimeType ?? "application/octet-stream", payload.dataBase64)];
	}
	if (isEncodableImage(value)) return [{ kind: "encode", value }];
	return undefined;
}

export async function encodeDisplayImage(value) {
	let raw;
	try {
		raw = typeof value.bytes === "function" ? await value.bytes() : await value.arrayBuffer();
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		return dropped(`encoding failed: ${error.message}`);
	}
	const bytes = bytesOf(raw);
	if (bytes === undefined) return dropped(`encoder returned ${describeImageData(raw)}, not bytes`);
	const declared = typeof value.type === "string" && value.type.startsWith("image/") ? value.type : undefined;
	const mimeType = declared ?? sniffImageMimeType(bytes);
	return mimeType === undefined
		? dropped("bytes carry no recognizable image signature")
		: [frame(mimeType, Buffer.from(bytes).toString("base64"))];
}
