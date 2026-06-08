import { Buffer } from "buffer";

const RESIDENT_STRING_MIN_BYTES = 32 * 1024;
const RESIDENT_STRING_PREFIX = "\u0000senpi-resident-string:v1:";

export interface ResidentStoreStats {
	blobCount: number;
	blobBytes: number;
}

export class ResidentStringStore {
	private strings = new Map<string, string>();
	private bytes = 0;
	private nextId = 0;

	clear(): void {
		this.strings.clear();
		this.bytes = 0;
		this.nextId = 0;
	}

	stats(): ResidentStoreStats {
		return {
			blobCount: this.strings.size,
			blobBytes: this.bytes,
		};
	}

	externalize<T>(value: T): T {
		return transformJson(value, (text) => this.externalizeString(text));
	}

	materialize<T>(value: T): T {
		return transformJson(value, (text) => this.materializeString(text));
	}

	private externalizeString(text: string): string {
		if (text.length < RESIDENT_STRING_MIN_BYTES || text.startsWith(RESIDENT_STRING_PREFIX)) {
			return text;
		}

		const id = `${this.nextId++}`;
		this.strings.set(id, text);
		this.bytes += Buffer.byteLength(text, "utf8");
		return `${RESIDENT_STRING_PREFIX}${id}`;
	}

	private materializeString(text: string): string {
		if (!text.startsWith(RESIDENT_STRING_PREFIX)) {
			return text;
		}

		const id = text.slice(RESIDENT_STRING_PREFIX.length);
		return this.strings.get(id) ?? text;
	}
}

function transformJson<T>(value: T, transformString: (text: string) => string): T {
	const serialized = JSON.stringify(value, (_key, item: unknown) =>
		typeof item === "string" ? transformString(item) : item,
	);
	return JSON.parse(serialized) as T;
}
