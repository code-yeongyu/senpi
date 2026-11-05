import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { anchoredKeyFactsReader } from "../../src/core/egress/key-facts-client.ts";
import {
	acceptedRevocations,
	isVouchRevoked,
	newWrapAllowed,
	REVOCATION_MAX_AGE_MS,
	readVerifierRevocations,
	recordVerifierRevocations,
	type VerifierRevocation,
	verifierRevocationsPath,
} from "../../src/core/egress/verifier-revocations.ts";
import { canonical, signedEnvelope, type Verifier, verifierKey } from "./signed-entry.ts";

const VERIFIER_NOW = 90_000_000;
const pin = (keyId: string, generation: number) => ({ keyId, generation, spki: "AA==" });
const PINS = [pin("v1", 1), pin("v2", 2), pin("v3", 3)];

let root: string;
let path: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ck11-revocations-"));
	path = verifierRevocationsPath(root);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("acceptedRevocations", () => {
	// Design 15.10 "Signed revocation statements": "A whole-key revocation is accepted only if signed by a pinned key
	// of a strictly higher generation than the key it revokes, and that signer is not itself revoked".
	it("accepts a whole-key revocation only from a strictly higher, unrevoked pinned generation", () => {
		const whole: VerifierRevocation = { keyId: "v2" };
		expect(acceptedRevocations([whole], pin("v3", 3), PINS, [])).toEqual([whole]);
		expect(acceptedRevocations([whole], pin("v2", 2), PINS, [])).toEqual([]);
		expect(acceptedRevocations([{ keyId: "v3" }], pin("v2", 2), PINS, [])).toEqual([]);
		expect(acceptedRevocations([whole], pin("v3", 3), PINS, [{ keyId: "v3" }])).toEqual([]);
	});

	// Design 15.10 "Signed revocation statements": "a window revocation may be signed by the same or a higher
	// generation".
	it("accepts a window revocation from the same or a higher generation, never a lower one", () => {
		const window: VerifierRevocation = { keyId: "v2", from: 10, to: 20 };
		expect(acceptedRevocations([window], pin("v2", 2), PINS, [])).toEqual([window]);
		expect(acceptedRevocations([window], pin("v3", 3), PINS, [])).toEqual([window]);
		expect(acceptedRevocations([window], pin("v1", 1), PINS, [])).toEqual([]);
	});

	it("ignores a revocation of a key this release does not pin, so it cannot block a future generation", () => {
		expect(acceptedRevocations([{ keyId: "v4" }], pin("v3", 3), PINS, [])).toEqual([]);
	});
});

describe("isVouchRevoked", () => {
	// Design 15.10: "treat any LocalKeyVerification whose verifierKeyId/vouchedAt falls under a revocation as absent".
	it("covers every statement of a whole-key revocation and only the readAt window of a window revocation", () => {
		const held: VerifierRevocation[] = [{ keyId: "v1" }, { keyId: "v2", from: 10, to: 20 }];
		expect(isVouchRevoked(held, "v1", 5)).toBe(true);
		expect([9, 10, 20, 21].map((at) => isVouchRevoked(held, "v2", at))).toEqual([false, true, true, false]);
		expect(isVouchRevoked(held, "v3", 15)).toBe(false);
	});
});

describe("verifier revocation store", () => {
	// Design 15.10: "Clients persist accepted revocations monotonically (a revocation never un-happens on this device)".
	it("keeps every accepted revocation across writes and never drops one", async () => {
		expect(await recordVerifierRevocations(path, [{ keyId: "v1" }])).toBe(true);
		expect(await recordVerifierRevocations(path, [{ keyId: "v2", from: 1, to: 2 }])).toBe(true);
		expect(await recordVerifierRevocations(path, [{ keyId: "v1" }])).toBe(true);
		expect(await readVerifierRevocations(path)).toEqual({
			state: "ok",
			revocations: [{ keyId: "v1" }, { keyId: "v2", from: 1, to: 2 }],
		});
	});

	it("reads an unreadable file as unknown and never overwrites it, so no revocation can be lost", async () => {
		await mkdir(dirname(path), { recursive: true });
		writeFileSync(path, "{");
		expect(await readVerifierRevocations(path)).toEqual({ state: "unknown" });
		expect(await recordVerifierRevocations(path, [{ keyId: "v1" }])).toBe(false);
		expect(readFileSync(path, "utf8")).toBe("{");
	});
});

describe("newWrapAllowed", () => {
	// Design 15.10 / 15.15 M-3: "A record authorizes a new wrap only if this device holds a verified revocation
	// statement with statement.issuedAt >= record.vouchedAt (both verifier-signed ...) whose local monotonic age since
	// fetch is at most 6 h"; "A device that has never fetched revocations makes no new wrap."
	it("needs a statement issued at or after the record's vouchedAt, fetched at most 6 h ago on the monotonic clock", () => {
		const fresh = { issuedAt: 1_000, fetchedMono: 50 };
		expect(newWrapAllowed(1_000, undefined, 50)).toBe(false);
		expect(newWrapAllowed(1_000, fresh, 50)).toBe(true);
		expect(newWrapAllowed(1_001, fresh, 50)).toBe(false);
		expect(newWrapAllowed(1_000, fresh, 50 + REVOCATION_MAX_AGE_MS)).toBe(true);
		expect(newWrapAllowed(1_000, fresh, 51 + REVOCATION_MAX_AGE_MS)).toBe(false);
		expect(newWrapAllowed(1_000, fresh, 49)).toBe(false);
	});
});

describe("revocation fetch through the anchored reader", () => {
	let server: Server;
	let endpoint: string;
	let body: (nonce: string) => Promise<string>;
	let v1: Verifier;
	let v2: Verifier;

	beforeAll(async () => {
		[v1, v2] = await Promise.all([verifierKey("v1", 1), verifierKey("v2", 2)]);
		server = createServer((request, response: ServerResponse) => {
			const nonce = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("nonce") ?? "";
			void body(nonce).then((text) => {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(text);
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	const statement = (nonce: string, revocations: VerifierRevocation[], issuedAt = VERIFIER_NOW) =>
		canonical({ v: 1, kind: "revocations", nonce, issuedAt, revocations, verifierKeyId: "v2" });

	// Design 15.10 / 15.15 M-3: the new-wrap rule compares two verifier-signed times on one clock and the local
	// monotonic age since fetch, so a device wall clock 10 min behind the verifier changes nothing.
	it("new-wrap-needs-fresh-revocations: a fetched statement authorizes wraps whatever the device wall clock says", async () => {
		let mono = 7;
		const reader = anchoredKeyFactsReader({
			endpoint,
			verifierKeys: [v1.pin, v2.pin],
			revocationsPath: path,
			now: () => VERIFIER_NOW - 10 * 60_000,
			monoNow: () => mono,
		});
		expect(newWrapAllowed(VERIFIER_NOW - 1_000, reader.revocationFreshness(), mono)).toBe(false);
		body = async (nonce) => signedEnvelope(statement(nonce, []), v2.signer);
		expect(await reader.refreshRevocations()).toBe(true);
		expect(reader.revocationFreshness()).toEqual({ issuedAt: VERIFIER_NOW, fetchedMono: 7 });
		expect(newWrapAllowed(VERIFIER_NOW - 1_000, reader.revocationFreshness(), mono)).toBe(true);
		expect(newWrapAllowed(VERIFIER_NOW + 1, reader.revocationFreshness(), mono)).toBe(false);
		mono += REVOCATION_MAX_AGE_MS + 1;
		expect(newWrapAllowed(VERIFIER_NOW - 1_000, reader.revocationFreshness(), mono)).toBe(false);
	});

	// Design 15.10: "Clients persist accepted revocations monotonically"; "A whole-key revocation is accepted only if
	// signed by a pinned key of a strictly higher generation".
	it("persists a fetched revocation, and a later statement without it cannot take it back", async () => {
		const reader = anchoredKeyFactsReader({ endpoint, verifierKeys: [v1.pin, v2.pin], revocationsPath: path });
		body = async (nonce) => signedEnvelope(statement(nonce, [{ keyId: "v1" }]), v2.signer);
		expect(await reader.refreshRevocations()).toBe(true);
		body = async (nonce) => signedEnvelope(statement(nonce, []), v2.signer);
		expect(await reader.refreshRevocations()).toBe(true);
		expect(await readVerifierRevocations(path)).toEqual({ state: "ok", revocations: [{ keyId: "v1" }] });
	});

	it("refuses a statement with a foreign nonce, and keeps the store unchanged", async () => {
		const reader = anchoredKeyFactsReader({ endpoint, verifierKeys: [v1.pin, v2.pin], revocationsPath: path });
		body = async () => signedEnvelope(statement("AAAAAAAAAAAAAAAAAAAAAA", [{ keyId: "v1" }]), v2.signer);
		expect(await reader.refreshRevocations()).toBe(false);
		expect(reader.revocationFreshness()).toBeUndefined();
		expect(await readVerifierRevocations(path)).toEqual({ state: "ok", revocations: [] });
	});
});
