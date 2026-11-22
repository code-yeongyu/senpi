import { createCipheriv, createDecipheriv } from "node:crypto";

export type InternalDirection = "c2s" | "s2c";
export const INTERNAL_RECORD_MAX = 64 * 1024;
const RECORD_LIMIT = 1n << 32n;

/** One connection direction. A failed authentication never advances its receive counter. */
export class InternalRecordCipher {
	private readonly key: Buffer;
	private readonly direction: InternalDirection;
	private counter: bigint;

	constructor(key: Buffer, direction: InternalDirection, counter = 0n) {
		this.key = key;
		this.direction = direction;
		this.counter = counter;
	}

	private parameters(): { nonce: Buffer; aad: Buffer } {
		if (this.counter < 0n || this.counter >= RECORD_LIMIT) throw new Error("internal_record_counter_exhausted");
		const count = Buffer.alloc(8);
		count.writeBigUInt64BE(this.counter);
		return {
			nonce: Buffer.concat([Buffer.alloc(4), count]),
			aad: Buffer.concat([Buffer.from(this.direction), count]),
		};
	}

	seal(plaintext: Buffer): Buffer {
		if (plaintext.length < 1 || plaintext.length > INTERNAL_RECORD_MAX) throw new Error("internal_record_length");
		const { nonce, aad } = this.parameters();
		const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
		cipher.setAAD(aad);
		const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
		const length = Buffer.alloc(4);
		length.writeUInt32BE(body.length);
		this.counter++;
		return Buffer.concat([length, body]);
	}

	open(body: Buffer): Buffer {
		if (body.length < 17 || body.length > INTERNAL_RECORD_MAX + 16) throw new Error("internal_record_length");
		const { nonce, aad } = this.parameters();
		const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
		decipher.setAAD(aad);
		decipher.setAuthTag(body.subarray(-16));
		const plaintext = decipher.update(body.subarray(0, -16));
		// Nothing produced by update may reach JSONL until final verifies the tag.
		const final = decipher.final();
		this.counter++;
		return Buffer.concat([plaintext, final]);
	}
}
