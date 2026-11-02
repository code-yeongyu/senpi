import { describe, expect, it } from "vitest";
import { redactShareText, type ShareRedactionContext } from "../../../src/core/share/share-redaction.ts";
import { redactShareValue } from "../../../src/core/share/share-redaction-value.ts";

// senpi#3524 review round 2: generated secrets that match no provider shape (standard base64 from
// `openssl rand -base64`, AWS secret keys, Azure account keys, and tokens wrapped across a line break)
// must be redacted, while ordinary code (commit ids, digests, UUIDs, ULIDs, identifiers, paths) survives.
// Values come from a seeded generator, so every run checks the same samples.

const context: ShareRedactionContext = { homeDirectory: "/Users/jane doe", userName: "janedoe", hostName: "h.local" };
const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const BASE64 = `${BASE62}+/`;
const SAMPLES = 300;

function mulberry32(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function draw(random: () => number, alphabet: string, length: number): string {
	return Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)] ?? "A").join("");
}

function randomBase64(random: () => number, bytes: number): string {
	return Buffer.from(Array.from({ length: bytes }, () => Math.floor(random() * 256))).toString("base64");
}

function redact(text: string): string {
	return redactShareText(text, context, new Map());
}

const SHAPES: ReadonlyArray<readonly [string, (random: () => number) => { text: string; secrets: string[] }]> = [
	[
		"an `openssl rand -base64 32` value",
		(random) => {
			const value = randomBase64(random, 32);
			return { text: `generated ${value} for the session`, secrets: [value] };
		},
	],
	[
		"an AWS secret access key",
		(random) => {
			const value = draw(random, BASE64, 40);
			return { text: `aws secret ${value} here`, secrets: [value] };
		},
	],
	[
		"an Azure account key",
		(random) => {
			const value = randomBase64(random, 64);
			return { text: `AccountName=demo;AccountKey ${value} end`, secrets: [value] };
		},
	],
	[
		"a base62 token wrapped 24/24 across a line break",
		(random) => {
			const head = draw(random, BASE62, 24);
			const tail = draw(random, BASE62, 24);
			return { text: `token is ${head}\n${tail} done`, secrets: [head, tail] };
		},
	],
	[
		"a prefixed key whose tail wraps to the next line",
		(random) => {
			const head = `${"sk"}-proj-${draw(random, BASE62, 30)}`;
			const tail = draw(random, BASE62, 18);
			return { text: `${head}\n${tail}\nnext line`, secrets: [head, tail] };
		},
	],
	[
		"a 32-character base62 token",
		(random) => {
			const value = draw(random, BASE62, 32);
			return { text: `key ${value} ok`, secrets: [value] };
		},
	],
	[
		"a 16-byte base64 value",
		(random) => {
			const value = randomBase64(random, 16);
			return { text: `secret ${value} ok`, secrets: [value] };
		},
	],
	...(
		[
			["an escaped \\n inside JSON text", "\\n"],
			["an escaped \\r\\n inside JSON text", "\\r\\n"],
			["a backslash line continuation", "\\\n"],
			["a string-concat seam", '" +\n  "'],
			["an array seam", '",\n "'],
		] as const
	).map(
		([label, gap]) =>
			[
				`a base62 token split by ${label}`,
				(random: () => number) => {
					const head = draw(random, BASE62, 24);
					const tail = draw(random, BASE62, 24);
					return { text: `{"output":"token is ${head}${gap}${tail} done"}`, secrets: [head, tail] };
				},
			] as const,
	),
];

describe("generated secrets with no provider shape (senpi#3524)", () => {
	it.each(SHAPES)("redacts every sample of %s", (_label, make) => {
		const random = mulberry32(3524);
		const leaked: string[] = [];
		for (let sample = 0; sample < SAMPLES; sample++) {
			const { text, secrets } = make(random);
			const out = redact(text);
			for (const secret of secrets) if (out.includes(secret)) leaked.push(secret);
		}
		expect(leaked).toEqual([]);
	});

	it("redacts 2000 of 2000 32-character base62 tokens from a second seed", () => {
		const random = mulberry32(32);
		const leaked: string[] = [];
		for (let sample = 0; sample < 2000; sample++) {
			const value = draw(random, BASE62, 32);
			if (redact(`key ${value} ok`).includes(value)) leaked.push(value);
		}
		expect(leaked).toEqual([]);
	});

	it("redacts a token split across two structured text blocks", () => {
		const random = mulberry32(99);
		const leaked: string[] = [];
		for (let sample = 0; sample < SAMPLES; sample++) {
			const head = draw(random, BASE62, 24);
			const tail = draw(random, BASE62, 24);
			const blocks = [
				{ type: "text", text: `token is ${head}` },
				{ type: "text", text: `${tail} done` },
			];
			const out = JSON.stringify(redactShareValue(blocks, context, new Map()));
			for (const secret of [head, tail]) if (out.includes(secret)) leaked.push(secret);
		}
		expect(leaked).toEqual([]);
	});

	it("redacts the body of a PGP armored private key as a private key", () => {
		const tally = new Map();
		const begin = ["-----BEGIN PGP", "PRIVATE KEY BLOCK-----"].join(" ");
		const end = ["-----END PGP", "PRIVATE KEY BLOCK-----"].join(" ");
		const body = randomBase64(mulberry32(7), 96);
		const out = redactShareText(`key:\n${begin}\n\n${body}\n${end}\nafter`, context, tally);
		expect(out).toBe("key:\n<redacted private key>\nafter");
		expect(tally.get("private key")).toBe(1);
	});

	it.each([
		["a commit id", "fixed in 3c4bb588c07dd2d5843b6178a89a186d81f629c7"],
		["a sha256 digest", `sha256 ${"9f86d081884c7d65".repeat(4)}`],
		["a UUID", "session 01a14a28-fad7-7ebc-91a2-e85da2aa8faa"],
		["an uppercase GUID", "{3F2504E0-4F89-11D3-9A0C-0305E82C3301}"],
		["a ULID", "id 01ARZ3NDEKTSV4RRFFQ69G5FAV"],
		["a tool call id", "toolu_01QHGX43sJ4p5oGXbAb2QGLF returned"],
		["an identifier with digits", "call convertUtf8StringToBase64EncodedForm(x)"],
		["another identifier with digits", "new Sha256HashCalculatorForUtf8Input2()"],
		["an npm integrity hash", `"integrity": "sha512-${randomBase64(mulberry32(11), 64)}"`],
		["a repository path", "packages/coding-agent/src/core/share/share-redaction.ts"],
		["a node_modules path", "node_modules/@earendil-works/pi-ai/dist/index.js"],
		["a URL", "https://github.com/code-yeongyu/senpi/pull/3540"],
		["a public key path", "PUBLIC_KEY_PATH=/etc/ssl/pub.pem"],
		["an auth mode", "AUTH_MODE=oauth"],
		["a null comparison", "if (session_id == null) return;"],
		[
			"help text with a slash list",
			"  PI_TELEMETRY  - set to 1/true/yes\nPI_RULES_DISABLED  - Disable built-in rules",
		],
		["a slash list before an identifier", "use VISUAL/EDITOR\nshellPath?: string"],
		["a format list before a word", "stored as JSONL/SQLite\nbindings are kept"],
		["a camelCase identifier with short pieces", "const handleUtf8ToBase64ConversionForV2Api = 1;"],
		["two words split across an escaped newline", '{"output":"configuration\\ninitialization"}'],
	])("keeps %s", (_label, input) => {
		expect(redact(input)).toBe(input);
	});
});
