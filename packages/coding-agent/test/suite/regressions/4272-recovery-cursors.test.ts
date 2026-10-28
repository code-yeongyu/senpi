import { inspect } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { type CursorBinding, RecoveryCursors } from "../../../src/modes/rpc/compact-recovery-cursor.ts";

// Part of #4272 (S11b, R4.B3, RULING-62 Q2 A + (1)(2)(4)): a page cursor is an opaque bounded id authenticated with
// HMAC-SHA-256 under a per-process key from the platform CSPRNG, truncated to 16 bytes; it binds the asking peer and
// session, the token, its generation, the component, the next raw byte offset and the page ordinal. The grammar
// (RULING-57 validator: length + allow-list) is checked BEFORE the MAC, the MAC is compared in constant time, and a
// tampered, foreign or pre-restart cursor answers exactly like an unknown one. The key never reaches any output.

const keys: Buffer[] = [];
const calls = { hmac: 0, timingSafe: 0 };

vi.mock("node:crypto", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:crypto")>();
	return {
		...original,
		randomBytes: ((size: number) => {
			const bytes = original.randomBytes(size);
			keys.push(Buffer.from(bytes));
			return bytes;
		}) as typeof original.randomBytes,
		createHmac: ((...args: Parameters<typeof original.createHmac>) => {
			calls.hmac += 1;
			return original.createHmac(...args);
		}) as typeof original.createHmac,
		timingSafeEqual: ((...args: Parameters<typeof original.timingSafeEqual>) => {
			calls.timingSafe += 1;
			return original.timingSafeEqual(...args);
		}) as typeof original.timingSafeEqual,
	};
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** RULING-62 Q2 A restated: the authenticator is HMAC-SHA-256 truncated to 16 bytes, never read from the encoder. */
const CURSOR_MAC_BYTES = 16;

const binding: CursorBinding = {
	socketEpoch: "socket-1",
	sessionId: "s",
	tokenId: "socket-1:1",
	generation: 1,
	componentRef: "c-0000000000000001:003",
};

it("RULING-62 Q2 A a cursor round-trips its ordinal and offset under its binding and is a bounded opaque id", () => {
	const cursors = new RecoveryCursors();
	const cursor = cursors.mint(binding, { ordinal: 7, offset: 131_072 });
	expect(cursor.length).toBeLessThanOrEqual(128);
	expect(cursor).toMatch(/^[A-Za-z0-9][A-Za-z0-9:_-]*$/);
	expect(cursors.open(cursor, binding)).toEqual({ ordinal: 7, offset: 131_072 });
	// The authenticator is exactly 16 bytes (32 hex characters) and the cursor carries no secret.
	expect(cursor).toMatch(new RegExp(`^p1:7:131072:[0-9a-f]{${CURSOR_MAC_BYTES * 2}}$`));
});

it("RULING-62 Q2 (1) a cursor presented by another peer, session, token, generation or component is unknown, with no state", () => {
	const cursors = new RecoveryCursors();
	const cursor = cursors.mint(binding, { ordinal: 1, offset: 10 });
	const foreign: CursorBinding[] = [
		{ ...binding, socketEpoch: "socket-2" },
		{ ...binding, sessionId: "t" },
		{ ...binding, tokenId: "socket-1:2" },
		{ ...binding, generation: 2 },
		{ ...binding, componentRef: "c-0000000000000001:004" },
	];
	for (const other of foreign) expect(cursors.open(cursor, other), JSON.stringify(other)).toBeUndefined();
	expect(cursors.open(cursor, binding)).toEqual({ ordinal: 1, offset: 10 });
});

it("RULING-62 Q2 (2) the grammar is checked before any MAC, the MAC compares in constant time, and a tampered cursor is unknown", () => {
	const cursors = new RecoveryCursors();
	const cursor = cursors.mint(binding, { ordinal: 3, offset: 262_144 });
	calls.hmac = 0;
	calls.timingSafe = 0;
	const malformed = [
		"",
		"nope",
		`${cursor}/x`,
		`${cursor}..`,
		cursor.toUpperCase(),
		`${cursor}${"0".repeat(120)}`,
		" ",
	];
	for (const text of malformed) expect(cursors.open(text, binding), JSON.stringify(text)).toBeUndefined();
	expect(calls.hmac, "a malformed cursor never reaches the MAC").toBe(0);
	expect(calls.timingSafe).toBe(0);
	const mac = cursor.slice(-CURSOR_MAC_BYTES * 2);
	const flipped = `${cursor.slice(0, -CURSOR_MAC_BYTES * 2)}${mac.startsWith("0") ? "1" : "0"}${mac.slice(1)}`;
	expect(cursors.open(flipped, binding)).toBeUndefined();
	expect(calls.timingSafe, "an authentic-looking cursor is compared in constant time").toBe(1);
	// The clear fields are covered by the MAC: a forged offset or ordinal is a tampered cursor.
	const [version, ordinal, offset, tag] = cursor.split(":");
	expect(cursors.open([version, ordinal, String(Number(offset) + 1), tag].join(":"), binding)).toBeUndefined();
	expect(cursors.open([version, String(Number(ordinal) + 1), offset, tag].join(":"), binding)).toBeUndefined();
	expect(cursors.open(cursor, binding)).toEqual({ ordinal: 3, offset: 262_144 });
});

it("RULING-62 Q2 (4) a cursor minted under another process key (before a restart) is unknown here", () => {
	const before = new RecoveryCursors();
	const after = new RecoveryCursors();
	const cursor = before.mint(binding, { ordinal: 2, offset: 5 });
	expect(after.open(cursor, binding)).toBeUndefined();
	expect(before.open(cursor, binding)).toEqual({ ordinal: 2, offset: 5 });
});

it("RULING-62 Q2 (2) the key comes from the CSPRNG and never appears in a cursor, a log line, an error or an inspection", () => {
	const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	const logged: string[] = [];
	vi.spyOn(console, "log").mockImplementation((...args) => void logged.push(args.map(String).join(" ")));
	vi.spyOn(console, "error").mockImplementation((...args) => void logged.push(args.map(String).join(" ")));
	keys.length = 0;
	const cursors = new RecoveryCursors();
	expect(keys, "one 32-byte key drawn from the platform CSPRNG").toHaveLength(1);
	expect(keys[0]?.length).toBe(32);
	const output: string[] = [];
	const cursor = cursors.mint(binding, { ordinal: 1, offset: 0 });
	output.push(cursor);
	for (const text of [cursor, "garbage", `${cursor.slice(0, -1)}x`]) {
		try {
			output.push(String(cursors.open(text, { ...binding, socketEpoch: "socket-9" })));
		} catch (cause) {
			output.push(String(cause), inspect(cause, { depth: 10 }));
		}
	}
	output.push(String(cursors), JSON.stringify(cursors), inspect(cursors, { depth: 10, showHidden: true }));
	output.push(...logged);
	for (const call of [...stderr.mock.calls, ...stdout.mock.calls]) output.push(String(call[0]));
	const everything = output.join("\n");
	for (const key of keys) {
		for (const encoding of ["hex", "base64", "base64url", "latin1"] as const)
			expect(everything.includes(key.toString(encoding)), `key as ${encoding}`).toBe(false);
	}
	expect(everything.includes("Buffer")).toBe(false);
});
