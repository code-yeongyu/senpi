import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { parseBoundedId } from "./compact-recovery-ids.ts";

/**
 * What a page cursor binds (RULING-62 Q2 A + (1)): the asking peer incarnation and routing session, the token, its
 * generation and the component. None of it travels in the cursor; the cursor's authenticator is computed over it, so
 * a cursor presented under any other binding is simply unknown.
 */
export interface CursorBinding {
	readonly socketEpoch: string;
	readonly sessionId: string;
	readonly tokenId: string;
	readonly generation: number;
	readonly componentRef: string;
}

/** Where a cursor continues: the ordinal of the page it was minted with and the next raw byte offset. */
export interface CursorPosition {
	readonly ordinal: number;
	readonly offset: number;
}

/** The HMAC-SHA-256 authenticator is truncated to this many bytes (RULING-62 Q2 A). */
const CURSOR_MAC_BYTES = 16;
const CURSOR_VERSION = "p1";
/** A bounded decimal in its one canonical form (RULING-57): no leading zero, so `String(n)` is its only encoding. */
const DECIMAL = "(?:0|[1-9][0-9]{0,15})";
/** The whole grammar (RULING-57 validator shape): version, two canonical decimals, the hex authenticator. */
const CURSOR = new RegExp(`^${CURSOR_VERSION}:${DECIMAL}:${DECIMAL}:[0-9a-f]{${CURSOR_MAC_BYTES * 2}}$`);
const DOMAIN = "senpi-recovery-cursor/1";

/**
 * The per-process cursor key lives only in this closure: drawn from the platform CSPRNG once, never a property, never
 * serialized, never part of an error. A restart draws another, so every cursor of the previous process is unknown.
 */
function keyedAuthenticator(): (text: string) => Buffer {
	const key = randomBytes(32);
	return (text) => createHmac("sha256", key).update(text, "utf8").digest().subarray(0, CURSOR_MAC_BYTES);
}

const material = (binding: CursorBinding, position: CursorPosition): string =>
	[
		DOMAIN,
		binding.socketEpoch,
		binding.sessionId,
		binding.tokenId,
		String(binding.generation),
		binding.componentRef,
		String(position.ordinal),
		String(position.offset),
	]
		.map((field) => `${Buffer.byteLength(field)}:${field}`)
		.join("\u0000");

/**
 * Opaque bounded page cursors (RULING-62 Q2 A): `<version>:<ordinal>:<offset>:<mac>`, an allow-listed ASCII id of at
 * most 128 bytes whose authenticator covers the binding and the position. `open` checks length and grammar before any
 * MAC work and compares authenticators in constant time; it answers the position or undefined, never why.
 */
export class RecoveryCursors {
	private readonly authenticate = keyedAuthenticator();

	mint(binding: CursorBinding, position: CursorPosition): string {
		const mac = this.authenticate(material(binding, position)).toString("hex");
		return `${CURSOR_VERSION}:${position.ordinal}:${position.offset}:${mac}`;
	}

	open(cursor: string, binding: CursorBinding): CursorPosition | undefined {
		if (!parseBoundedId(cursor).ok || !CURSOR.test(cursor)) return undefined;
		const [, ordinal, offset, mac] = cursor.split(":");
		const position = { ordinal: Number(ordinal), offset: Number(offset) };
		if (!Number.isSafeInteger(position.ordinal) || !Number.isSafeInteger(position.offset)) return undefined;
		const expected = this.authenticate(material(binding, position));
		const presented = Buffer.from(mac ?? "", "hex");
		return presented.length === expected.length && timingSafeEqual(presented, expected) ? position : undefined;
	}
}
