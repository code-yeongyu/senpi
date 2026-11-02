import { Buffer } from "node:buffer";

export class RawOutputTail {
	private readonly limit: number;
	private buffer = Buffer.alloc(0);
	private byteCount = 0;

	constructor(limit: number) {
		this.limit = limit;
	}

	get bytes(): Buffer {
		return Buffer.from(this.buffer);
	}

	get totalBytes(): number {
		return this.byteCount;
	}

	append(chunk: Buffer): void {
		this.byteCount += chunk.byteLength;
		if (this.limit === 0) {
			this.buffer = Buffer.alloc(0);
			return;
		}
		const next = Buffer.concat([this.buffer, chunk]);
		this.buffer = next.byteLength <= this.limit ? next : next.subarray(next.byteLength - this.limit);
	}
}
