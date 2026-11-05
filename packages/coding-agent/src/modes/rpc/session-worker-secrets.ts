import { SESSION_WORKER_LIMITS } from "./session-worker-protocol.ts";

const SECRET_FRAME_TYPES = ["extension_ui_request", "secret_input_settled"] as const;
type SecretFrameType = (typeof SECRET_FRAME_TYPES)[number];

function secretFrameType(record: object): SecretFrameType | undefined {
	const type: unknown = "type" in record ? record.type : undefined;
	return SECRET_FRAME_TYPES.find((known) => known === type);
}

/**
 * The secret ids one worker holds on the host, and the frames each may still send (senpi#5192).
 * Secret frames travel on the control exchange, outside the payload frame bound, so every count and size is bounded here.
 */
export class WorkerSecretIds {
	private readonly sent = new Map<string, Set<SecretFrameType>>();

	has(id: string): boolean {
		return this.sent.has(id);
	}

	ids(): Iterable<string> {
		return this.sent.keys();
	}

	admitsNew(): boolean {
		if (this.sent.size >= SESSION_WORKER_LIMITS.secretIds) return false;
		let open = 0;
		for (const sent of this.sent.values()) if (!sent.has("secret_input_settled")) open++;
		return open < SESSION_WORKER_LIMITS.secretInputs;
	}

	add(id: string): void {
		if (!this.sent.has(id)) this.sent.set(id, new Set());
	}

	/** A live id's request and settled record, each at most once and within `secretFrameBytes`; a refusal spends nothing. */
	admitFrame(id: string, record: object): boolean {
		const sent = this.sent.get(id);
		const type = secretFrameType(record);
		if (!sent || type === undefined || sent.has(type)) return false;
		if (Buffer.byteLength(JSON.stringify(record)) > SESSION_WORKER_LIMITS.secretFrameBytes) return false;
		sent.add(type);
		return true;
	}

	forget(id: string): void {
		this.sent.delete(id);
	}

	clear(): void {
		this.sent.clear();
	}
}
