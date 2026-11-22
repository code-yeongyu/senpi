import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AnchoredKeyFactsReader, anchoredKeyFactsReader } from "../../src/core/egress/key-facts-client.ts";
import {
	readVerifierRevocations,
	recordVerifierRevocations,
	verifierRevocationsPath,
} from "../../src/core/egress/verifier-revocations.ts";
import { canonical, signedEnvelope, type Verifier, verifierKey } from "./signed-entry.ts";

const ARN = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-4000-8000-0000000000aa";
const NOW = 80_000_000;

const wireFacts = {
	spki: Buffer.from("kem-spki-bytes").toString("base64"),
	origin: "AWS_KMS",
	keySpec: "ECC_NIST_P256",
	keyUsage: "KEY_AGREEMENT",
	keyManager: "CUSTOMER",
	keyState: "Enabled",
	multiRegion: false,
	tags: { "omo-custody": "true" },
	policy: "{}",
	grantCount: 0,
};

type Route = (request: { path: string; nonce: string }, response: ServerResponse) => Promise<void> | void;

let server: Server;
let endpoint: string;
let route: Route;
let root: string;
let revocationsPath: string;
let v1: Verifier;
let v2: Verifier;
let outsider: Verifier;
let mono: number;

const factsStatement = (nonce: string, overrides: Record<string, unknown> = {}) => ({
	v: 1,
	kind: "facts",
	arn: ARN,
	nonce,
	readAt: NOW - 1_000,
	facts: wireFacts,
	verifierKeyId: "verifier-1",
	...overrides,
});

const revocationsStatement = (nonce: string, revocations: unknown[], signerId = "verifier-1") => ({
	v: 1,
	kind: "revocations",
	nonce,
	issuedAt: NOW,
	revocations,
	verifierKeyId: signerId,
});

function json(response: ServerResponse, body: string, contentType = "application/json"): void {
	response.writeHead(200, { "content-type": contentType });
	response.end(body);
}

function serve(facts: (nonce: string) => Promise<string>, revocations?: (nonce: string) => Promise<string>): void {
	route = async ({ path, nonce }, response) => {
		if (path.startsWith("/v1/revocations")) {
			json(
				response,
				await (
					revocations ?? ((n) => signedEnvelope(canonical(revocationsStatement(n, [], "verifier-2")), v2.signer))
				)(nonce),
			);
			return;
		}
		json(response, await facts(nonce));
	};
}

function reader(overrides: Partial<Parameters<typeof anchoredKeyFactsReader>[0]> = {}): AnchoredKeyFactsReader {
	return anchoredKeyFactsReader({
		endpoint,
		verifierKeys: [v1.pin, v2.pin],
		revocationsPath,
		now: () => NOW,
		monoNow: () => mono,
		...overrides,
	});
}

beforeAll(async () => {
	[v1, v2, outsider] = await Promise.all([
		verifierKey("verifier-1", 1),
		verifierKey("verifier-2", 2),
		verifierKey("verifier-9", 9),
	]);
	server = createServer((request: IncomingMessage, response: ServerResponse) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		void route({ path: url.pathname, nonce: url.searchParams.get("nonce") ?? "" }, response);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ck11-facts-"));
	revocationsPath = verifierRevocationsPath(root);
	mono = 1_000;
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const honest = (nonce: string) => signedEnvelope(canonical(factsStatement(nonce)), v1.signer);

describe("anchored key-facts reader (custody design 15.10)", () => {
	it("returns the verifier-signed facts with the signer and the signed readAt", async () => {
		serve(honest);
		expect(await reader().describe(ARN)).toEqual({ ...wireFacts, readAt: NOW - 1_000, verifierKeyId: "verifier-1" });
	});

	it("answers unknown when no endpoint or no verifier key is pinned", async () => {
		serve(honest);
		expect(await reader({ endpoint: undefined }).describe(ARN)).toBe("unknown");
		expect(await reader({ verifierKeys: [] }).describe(ARN)).toBe("unknown");
	});

	it("answers unknown for unsigned facts served over the channel", async () => {
		serve(async (nonce) => JSON.stringify(factsStatement(nonce)));
		expect(await reader().describe(ARN)).toBe("unknown");
	});

	it("answers unknown for a statement that names a pinned key but is signed by another key", async () => {
		serve((nonce) => signedEnvelope(canonical(factsStatement(nonce)), outsider.signer));
		expect(await reader().describe(ARN)).toBe("unknown");
	});

	it("answers unknown for a statement signed by an unpinned key under its own id", async () => {
		serve((nonce) =>
			signedEnvelope(canonical(factsStatement(nonce, { verifierKeyId: "verifier-9" })), outsider.signer),
		);
		expect(await reader().describe(ARN)).toBe("unknown");
	});

	it("answers unknown for a statement whose signer is not the key it names", async () => {
		serve((nonce) => signedEnvelope(canonical(factsStatement(nonce, { verifierKeyId: "verifier-2" })), v1.signer));
		expect(await reader().describe(ARN)).toBe("unknown");
	});

	it("answers unknown for a statement signed by a revoked verifier key, and accepts its successor", async () => {
		expect(await recordVerifierRevocations(revocationsPath, [{ keyId: "verifier-1" }])).toBe(true);
		serve(honest);
		expect(await reader().describe(ARN)).toBe("unknown");
		serve((nonce) => signedEnvelope(canonical(factsStatement(nonce, { verifierKeyId: "verifier-2" })), v2.signer));
		expect(await reader().describe(ARN)).toMatchObject({ verifierKeyId: "verifier-2" });
	});

	it("answers unknown when the payload is an object rather than the signed string", async () => {
		serve(async (nonce) => {
			const envelope = JSON.parse(await honest(nonce));
			return JSON.stringify({ ...envelope, payload: factsStatement(nonce) });
		});
		expect(await reader().describe(ARN)).toBe("unknown");
	});

	it("answers unknown for a payload re-encoded with a duplicate field under the original bytes' signature", async () => {
		serve(async (nonce) => {
			const envelope = JSON.parse(await honest(nonce));
			const text = canonical(factsStatement(nonce));
			const duplicated = text.replace('{"arn":', `{"arn":"${ARN.replace("aa", "ff")}","arn":`);
			return JSON.stringify({ ...envelope, payload: Buffer.from(duplicated).toString("base64url") });
		});
		expect(await reader().describe(ARN)).toBe("unknown");
	});

	it.each([
		["an unknown field", (text: string) => canonical({ ...JSON.parse(text), extra: 1 })],
		["trailing bytes", (text: string) => `${text} `],
		["a duplicate field", (text: string) => text.replace('{"arn":', `{"arn":"${ARN.replace("aa", "ff")}","arn":`)],
		["a missing field", (text: string) => text.replace(/"readAt":\d+,/, "")],
		// senpi#5961: signed bytes carry exactly one encoding. A decoder that strips a leading byte-order mark
		// would let EF BB BF + canonical JSON pass the "bytes equal their canonical JSON" rule.
		["a leading byte-order mark", (text: string) => `\uFEFF${text}`],
	])("answers unknown for signed bytes with %s", async (_name, edit) => {
		serve((nonce) => signedEnvelope(edit(canonical(factsStatement(nonce))), v1.signer));
		expect(await reader().describe(ARN)).toBe("unknown");
	});

	it("refuses stale or future-dated facts with a typed facts-stale answer that carries the skew", async () => {
		serve((nonce) => signedEnvelope(canonical(factsStatement(nonce, { readAt: NOW - 200_000 })), v1.signer));
		expect(await reader().describe(ARN)).toEqual({ refusal: "facts-stale", skewMs: 200_000 });
		serve((nonce) => signedEnvelope(canonical(factsStatement(nonce, { readAt: NOW + 60_000 })), v1.signer));
		expect(await reader().describe(ARN)).toEqual({ refusal: "facts-stale", skewMs: -60_000 });
	});

	it("answers unknown when the ARN echo differs from the requested ARN", async () => {
		serve((nonce) => signedEnvelope(canonical(factsStatement(nonce, { arn: ARN.replace("aa", "ff") })), v1.signer));
		expect(await reader().describe(ARN)).toBe("unknown");
	});

	it("answers unknown when the nonce echo differs, including a replayed earlier statement", async () => {
		let first: string | undefined;
		serve(async (nonce) => {
			first ??= await honest(nonce);
			return first;
		});
		expect(await reader().describe(ARN)).toMatchObject({ verifierKeyId: "verifier-1" });
		expect(await reader().describe(ARN)).toBe("unknown");
		serve((nonce) => signedEnvelope(canonical(factsStatement(`${nonce.slice(1)}A`)), v1.signer));
		expect(await reader().describe(ARN)).toBe("unknown");
	});

	it("answers unknown for a body over 64 KiB, a redirect, a wrong content type or a non-200 status", async () => {
		serve(async (nonce) => JSON.stringify({ ...JSON.parse(await honest(nonce)), pad: "x".repeat(64 * 1024) }));
		expect(await reader().describe(ARN)).toBe("unknown");
		route = (request, response) => {
			if (request.path.startsWith("/v1/keys")) {
				response.writeHead(302, { location: `/elsewhere?nonce=${request.nonce}` });
				response.end();
			} else void honest(request.nonce).then((body) => json(response, body));
		};
		expect(await reader().describe(ARN)).toBe("unknown");
		route = (request, response) => void honest(request.nonce).then((body) => json(response, body, "text/plain"));
		expect(await reader().describe(ARN)).toBe("unknown");
		route = (_request, response) => {
			response.writeHead(500, { "content-type": "application/json" });
			response.end("{}");
		};
		expect(await reader().describe(ARN)).toBe("unknown");
	});

	it("answers unknown when 10 s or more pass on the monotonic clock between send and answer", async () => {
		serve(async (nonce) => {
			mono += 10_000;
			return honest(nonce);
		});
		expect(await reader().describe(ARN)).toBe("unknown");
	});

	it("fetches revocations with every facts read, and a just-revoked signer answers unknown", async () => {
		serve(honest, (nonce) =>
			signedEnvelope(canonical(revocationsStatement(nonce, [{ keyId: "verifier-1" }], "verifier-2")), v2.signer),
		);
		expect(await reader().describe(ARN)).toBe("unknown");
		expect(await readVerifierRevocations(revocationsPath)).toEqual({
			state: "ok",
			revocations: [{ keyId: "verifier-1" }],
		});
	});
});
