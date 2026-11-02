// The provider error boundary owns credential redaction for every pi-ai consumer: `redactSecrets` masks values by
// the shape they appear in, `sanitizeProviderErrorMessage` classifies a model configuration error on the raw text and
// keeps only the redacted text (senpi#4282). Fixture secrets are assembled at runtime and low-entropy so secret
// scanners never read them as real keys.

import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../src/types.ts";
import { assistantRecords, getAssistantCapture } from "../src/utils/assistant-capture.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { redactSecrets, sanitizeProviderErrorMessage } from "../src/utils/provider-error.ts";
import { redactCredentialShapes } from "../src/utils/secret-redaction.ts";

const secret = ["zzfixture", "4283", "valueQ"].join("");
const json = (value: unknown): string => JSON.stringify(value);
const ghp = `ghp_${"FIXTURE".repeat(3)}0008`;
const sk = `sk-${"proj"}FIXTURE0006`;
const jwt = ["eyJhbGciOiJub25lIn0", "eyJzdWIiOiJmaXh0dXJlIn0", "Zml4dHVyZS1zaWcx"].join(".");

// senpi#4283: include every prefix alias and JWT, not just the two GitHub alphabets.
// A body marker catches partial leaks even when the first key consumed the next key's prefix.
const SUFFIX_SHAPES = [
	...[
		["sk-", 12],
		...["sk_live_", "sk_test_", "rk_live_", "rk_test_"].map((prefix) => [prefix, 24] as const),
		...["gsk_", "xai-", "hf_"].map((prefix) => [prefix, 24] as const),
		...["xoxa-", "xoxb-", "xoxo-", "xoxp-", "xoxr-", "xoxs-"].map((prefix) => [prefix, 24] as const),
		...["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"].map((prefix) => [prefix, 24] as const),
		...["AKIA", "ASIA"].map((prefix) => [prefix, 16] as const),
		["AIza", 32],
	].map(([prefix, length]) => ({
		label: String(prefix),
		value: `${prefix}${"F".repeat(Number(length))}`,
		marker: "F".repeat(12),
	})),
	{ label: "JWT", value: jwt, marker: "eyJzdWIiOiJmaXh0dXJlIn0" },
];
const SECOND_SHAPES = ["ghp_", "sk-proj-", "xoxb-"].map((prefix) => ({
	value: `${prefix}${"G".repeat(36)}`,
	marker: "G".repeat(12),
}));
const SUFFIX_SEPARATORS = ["/", ".", ":", "?", "&", "=", "_", "-", "", "z"];
const SUFFIX_TEMPLATES = [
	["EN", "rejected ", " while loading configuration"],
	["KO", "오류: ", " 구성 실패"],
	["path", "/repo/", " next"],
	["URL path", "https://example.test/", "?model=faux-1&stream=true"],
	["URL query", "https://example.test/?value=", "&model=faux-1"],
	["userinfo", "https://", "@example.test/repo"],
	["userinfo password", "https://user:", "@example.test/repo"],
] as const;
const SUFFIX_CASES = SUFFIX_SHAPES.flatMap((shape) =>
	SUFFIX_SEPARATORS.flatMap((separator) =>
		[undefined, ...SECOND_SHAPES].flatMap((second) =>
			SUFFIX_TEMPLATES.map(([template, before, after]) => ({
				label: `${shape.label} ${JSON.stringify(separator)} ${second?.value.slice(0, 8) ?? "ordinary"} ${template}`,
				before,
				after,
				value: shape.value,
				marker: shape.marker,
				second,
				text: `${before}${shape.value}${separator}${second?.value ?? ""}${after}`,
			})),
		),
	),
);

describe.each([
	["full", redactSecrets],
	["shapes", redactCredentialShapes],
] as const)("credential suffix boundaries (%s)", (_mode, redact) => {
	it.each(SUFFIX_CASES)("$label", ({ text, value, marker, second, before, after }) => {
		const result = redact(text);
		expect(result).not.toContain(value);
		expect(result).not.toContain(marker);
		if (second !== undefined) {
			expect(result).not.toContain(second.value);
			expect(result).not.toContain(second.marker);
		}
		expect(result.startsWith(before)).toBe(true);
		expect(result.endsWith(after)).toBe(true);
	});

	it.each(
		SUFFIX_SHAPES.filter(({ label }) => label !== "JWT").flatMap((shape) =>
			["/hooks.json", ".json", ":42", ""].map((suffix) => ({ ...shape, suffix })),
		),
	)("preserves $suffix after $label", ({ value, marker, suffix }) => {
		const result = redact(`/repo/${value}${suffix}`);
		expect(result).toBe(`/repo/[REDACTED]${suffix}`);
		expect(result).not.toContain(value);
		expect(result).not.toContain(marker);
	});
});

// senpi#4283: both public paths must consume the same logical separator, never its hex suffix. Generic values
// without a credential name remain readable in both; only the full redactor interprets credential names.
const ENCODING_CASES = ["upper", "lower", "mixed"] as const;
function encoded(separator: string, depth: number, hexCase: (typeof ENCODING_CASES)[number]): string {
	if (depth === 0) return separator;
	const hex = separator.charCodeAt(0).toString(16).padStart(2, "0");
	const digits = hexCase === "upper" || (hexCase === "mixed" && depth % 2 === 0) ? hex.toUpperCase() : hex;
	return `%${"25".repeat(depth - 1)}${digits}`;
}

const ENCODING_CELLS = ["/", ":", "@", "=", "?", "&", "#", " ", "+", "~", "-", "."].flatMap((separator) =>
	[0, 1, 2, 3].flatMap((depth) =>
		ENCODING_CASES.flatMap((hexCase) =>
			[
				["sk-proj", `sk-${"proj-"}FIXTURE0006`, true],
				["ghp", ghp, true],
				["JWT", jwt, true],
				["AWS", `AKIA${"FIXTURE"}000000010`, true],
				["generic", secret, false],
			].map(([kind, value, shaped]) => ({
				label: `${JSON.stringify(separator)} depth ${depth} ${hexCase} ${kind}`,
				text: `x${encoded(separator, depth, hexCase)}${value}`,
				value: String(value),
				shaped: Boolean(shaped),
			})),
		),
	),
);

// Encode any of the three characters of an escape independently, including at different depths.
// The same matrix owns positives and ordinary URL controls through both public redactors.
for (const separator of ["/", ":", "@", "=", "?", "&", "#", " ", "+", "~", "-", "."]) {
	for (const hexCase of ENCODING_CASES) {
		const escape = encoded(separator, 1, hexCase);
		for (const depths of [
			...[0, 1, 2].flatMap((a) => [0, 1, 2].flatMap((b) => [0, 1, 2].map((c) => [a, b, c]))),
			[3, 2, 1],
			[1, 3, 2],
		]) {
			const boundary = [...escape].map((c, index) => encoded(c, depths[index] ?? 0, hexCase)).join("");
			for (const [kind, value, shaped] of [
				["sk-proj", sk, true],
				["ghp", ghp, true],
				["JWT", jwt, true],
				["encoded JWT dots", jwt.split(".").join(boundary), separator === "."],
				["AWS", `AKIA${"FIXTURE"}000000010`, true],
				["ordinary URL", "example.test/tasks-abc?model=faux-1&stream=true", false],
			] as const) {
				if (kind === "encoded JWT dots" && separator !== ".") continue;
				ENCODING_CELLS.push({
					label: `${JSON.stringify(separator)} independent depths ${depths.join("/")} ${hexCase} ${kind}`,
					text: `x${boundary}${value}`,
					value,
					shaped,
				});
			}
		}
	}
}

describe("encoded separator equivalence", () => {
	describe.each([
		["full", redactSecrets],
		["shapes", redactCredentialShapes],
	] as const)("literal percent diagnostics (%s)", (_mode, redact) => {
		it.each([
			"rate 100%% then " + "x".repeat(62),
			"Progress: %d%% complete while contacting https://api.example.test/v1/...?model=faux-1 request id req_123 failed",
		])("keeps literal percent diagnostics unchanged: %s", (text) => {
			expect(redact(text)).toBe(text);
		});

		it.each(
			["%%", "%d", "%s", "100%", "%%%", "% ", "%zz"].flatMap((form) =>
				[60, 64, 65, 200].map((length) => ({ form, length })),
			),
		)("keeps literal $form before a $length-character tail", ({ form, length }) => {
			const text = `Progress: ${form}${"x".repeat(length)}`;
			expect(redact(text)).toBe(text);
		});
	});

	it.each(ENCODING_CELLS)("$label", ({ text, value, shaped }) => {
		const full = redactSecrets(text);
		const shapes = redactCredentialShapes(text);
		expect(shapes).toBe(full);
		if (shaped) {
			expect(full).toContain("[REDACTED]");
			expect(full).not.toContain(value);
		} else expect(full).toBe(text);
	});

	it.each([1, 2, 3, 32, 4096])("consumes depth %i once in URLs and named values", (depth) => {
		const e = (c: string): string => encoded(c, depth, "mixed");
		for (const text of [
			`https${e(":")}${e("/")}${e("/")}${ghp}${e("@")}github.com`,
			`redirect${e("=")}${e("/")}cb${e("/")}${jwt}`,
		]) {
			expect(redactCredentialShapes(text)).toBe(redactSecrets(text));
			expect(redactSecrets(text)).toContain("[REDACTED]");
		}
		expect(redactSecrets(`api_key${e("=")}${secret}`)).toBe(`api_key${e("=")}[REDACTED]`);
		expect(redactCredentialShapes(`api_key${e("=")}${secret}`)).toBe(`api_key${e("=")}${secret}`);
	});

	it.each([0, 1, 2, 3])("keeps ordinary encoded URLs readable at depth %i", (depth) => {
		for (const hexCase of ENCODING_CASES) {
			const e = (c: string): string => encoded(c, depth, hexCase);
			for (const text of [
				`https${e(":")}${e("/")}${e("/")}example.test${e("/")}tasks-abc${e("?")}model${e("=")}faux-1${e("&")}stream${e("=")}true${e("#")}cb`,
				...["A", "_", "0"].map((c) => `x${e(c)}${sk}`),
				`x%GG${sk}`,
			]) {
				expect(redactSecrets(text)).toBe(text);
				expect(redactCredentialShapes(text)).toBe(text);
			}
		}
	});

	it.each([0, 1, 2, 3])("interprets URL passwords only in full mode at depth %i", (depth) => {
		const e = (c: string): string => encoded(c, depth, "mixed");
		const text = `https${e(":")}${e("/")}${e("/")}user${e(":")}hunter2pass${e("@")}example.test`;
		expect(redactSecrets(text)).toBe(`https${e(":")}${e("/")}${e("/")}user${e(":")}[REDACTED]${e("@")}example.test`);
		expect(redactCredentialShapes(text)).toBe(text);
	});

	it.each([":x //user:hunter2pass@host", ":x y //user:hunter2pass@host"])(
		"does not carry stale userinfo state into shapes mode: %s",
		(text) => {
			expect(redactSecrets(text)).toBe(text);
			expect(redactCredentialShapes(text)).toBe(text);
		},
	);

	it.each([redactSecrets, redactCredentialShapes])("redacts conservatively on an unresolved window: %s", (redact) => {
		for (const head of ["", `x/${sk} `, "api_key"]) {
			const text = `${head}%${"%25".repeat(80)}%33%44${secret}`;
			const result = redact(text);
			expect(result).toContain("[REDACTED]");
			expect(result).not.toContain(secret);
			expect(result).not.toContain(sk);
			expect(redact(result)).toBe(result);
		}
	});

	it.each([1, 32, 4096])("joins canonical depth %i to independently encoded hex digits", (depth) => {
		for (const suffix of ["%32%46", "%32F", "2%46", "%2532%2546"]) {
			const boundary = `%${"25".repeat(depth)}${suffix}`;
			for (const redact of [redactSecrets, redactCredentialShapes]) {
				expect(redact(`x${boundary}${sk}`)).toBe(`x${boundary}[REDACTED]`);
				const ordinary = `https://example.test/${boundary}tasks-abc?model=faux-1`;
				expect(redact(ordinary)).toBe(ordinary);
			}
		}
	});
});

const REDACTED_SHAPES: readonly (readonly [label: string, text: string, leaked: string])[] = [
	["header line", `x-api-key: ${secret}`, secret],
	["camelCase JSON field", json({ apiKey: secret }), secret],
	["sessionToken query", `https://gateway.example.test/v1?sessionToken=${secret}`, secret],
	["session as the whole name", `session: ${secret}`, secret],
	["typographic quotes", `\u201Capi_key\u201D: \u201C${secret}\u201D`, secret],
	["full-width colon", `api_key\uFF1A ${secret}`, secret],
	["XML element", `<apiKey>${secret}</apiKey>`, secret],
	["HTML-escaped XML element", `&lt;apiKey&gt;${secret}&lt;/apiKey&gt;`, secret],
	["HTML-escaped JSON", `&quot;api_key&quot;: &quot;${secret}&quot;`, secret],
	["nested credentials object", json({ error: { credentials: { type: "service", value: secret } } }), secret],
	["escaped nested credentials object", json(json({ credentials: { value: secret } })), secret],
	["URL userinfo", `https://user:${secret}@gateway.example.test/v1`, secret],
	["short URL userinfo password", "https://user:pw@gateway.example.test/v1", ":pw@"],
	["Azure SAS signature", `https://acct.blob.example.test/c/b?sv=2024-11-04&sr=b&sig=${secret}`, secret],
	["second cookie pair after a short first", `Cookie: a=1; __cf_bm=${secret}`, secret],
	["short cookie value", "Cookie: a=1; sid=s3cr3t", "s3cr3t"],
	["set-cookie array", json({ "set-cookie": ["a=1", `sid=${secret}`] }), secret],
	["escaped set-cookie array", json(json({ "set-cookie": ["a=1", `sid=${secret}`] })), secret],
	["URL-encoded cookie", `model=faux-1&Cookie=${encodeURIComponent(`a=1; sid=${secret}`)}&stream=true`, secret],
	["gsk_ prefix", `rejected gsk_${"FIXTURE".repeat(3)}0012`, `gsk_${"FIXTURE".repeat(3)}0012`],
	["xai- prefix", `rejected xai-${"FIXTURE".repeat(3)}0013`, `xai-${"FIXTURE".repeat(3)}0013`],
	["hf_ prefix", `rejected hf_${"FIXTURE".repeat(3)}0014`, `hf_${"FIXTURE".repeat(3)}0014`],
	["rk_live_ prefix", `rejected rk_${"live_"}${"FIXTURE".repeat(3)}0015`, `${"FIXTURE".repeat(3)}0015`],
	["xoxb- prefix", `rejected xox${"b-"}${"FIXTURE".repeat(2)}-0016`, `${"FIXTURE".repeat(2)}-0016`],
	["numbered environment name", `OPENAI_API_KEY_2=${secret}`, secret],
	["digits glued to the word", `token2: ${secret}`, secret],
	["numbered header name", `x-api-key-1: ${secret}`, secret],
	["value qualifier", json({ api_key_value: secret }), secret],
	["camelCase id qualifier", json({ apiKeyId: secret }), secret],
	["a field named bearer", json({ bearer: "abcdefgh1234" }), "abcdefgh1234"],
	["a 130-character name", json({ [`${"a".repeat(130)}_api_key`]: secret }), secret],
	["a long dotted path", `request.headers.${"x".repeat(120)}.authorization: ${secret}`, secret],
	["a short password", json({ password: "hunter2-shrt" }), "hunter2-shrt"],
	["a short Basic credential", `Authorization: Basic ${["dXNl", "cjpw", "YXNz"].join("")}`, "dXNlcjpwYXNz"],
	[
		"a JWT ending a sentence",
		`rejected ${["eyJhbGciOiJub25lIn0", "eyJzdWIiOiJmaXh0dXJlIn0", "Zml4dHVyZS1zaWcx"].join(".")}.`,
		"eyJhbGci",
	],
	// Round 8: credential shapes inside a token (URL userinfo, paths, joined values), and whole strict values.
	["a token as git remote userinfo", `https://${ghp}@github.com/o/r.git`, ghp],
	["a token after git remote user:", `https://x-access-token:${ghp}@github.com/o/r.git`, ghp],
	["a key in a URL path segment", `/v1/keys/${sk}`, sk],
	["a key joined with +", `x+${sk}`, sk],
	["a key after ~/", `~/${sk}`, sk],
	["an AWS key id after /", `see /AKIA${"FIXTURE"}000000010`, "FIXTURE000000010"],
	["a JWT in a URL path", `/cb/${jwt}`, "eyJzdWIi"],
	["a JWT followed by a path", `/cb/${jwt}/more`, "eyJzdWIi"],
	["a key as proxy userinfo", `https://${sk}@proxy.example.test`, sk],
	["a token after user@", `deploy@${ghp}`, ghp],
	// Round 9 (senpi#4283): percent-encoded token boundaries still start a word.
	["a token in an encoded git remote", `https%3A%2F%2F${ghp}%40github.com`, ghp],
	["a key after an encoded path separator", `/v1%2F${sk}`, sk],
	["a JWT after an encoded path separator", `redirect=%2Fcb%2F${jwt}`, "eyJzdWIi"],
	["a key after encoded +", `x%2B${sk}`, sk],
	["a key after encoded ~", `x%7E${sk}`, sk],
	["a key after encoded -", `x%2D${sk}`, sk],
	["a key after encoded .", `x%2e${sk}`, sk],
	["a key after lowercase encoded /", `x%2f${sk}`, sk],
	["a quoted password with punctuation", 'password: "Hunter2!zzTailA01"', "zzTailA01"],
	["a bare password with @ and :", "password=p@zzTailA02:word123", "zzTailA02"],
	["a non-ASCII password", json({ password: "p\u00e4sswzzTailA03" }), "zzTailA03"],
	["a quoted password with spaces", json({ password: "abc def zzTailA04" }), "zzTailA04"],
	["an escaped quoted authorization", json(json({ authorization: "Bearer abc zzTailA05" })), "zzTailA05"],
	["an XML password with punctuation", "<password>ab!zzTailA06</password>", "zzTailA06"],
];

// Names that contain a credential word without holding a credential, and diagnostics, stay byte-identical.
const READABLE_TEXT: readonly string[] = [
	'"monkey": "abcdefghijklmnopqrstuvwxyz"',
	"turkey=abcdefghijklmnopqrstuv",
	'"keyword": "abcdefghijklmnopqrstuvwxyz"',
	'"tokenizer": "cl100k_base_tokenizer_v2"',
	"primary_key_column=customer_identifier_column",
	"max_tokens: 1234567890123456789",
	"session_id: 0f8fad5b-d9cb-469f-a165-70867728950e",
	"token_type: bearer_access_token_v2_long",
	"authorization_endpoint=api.example.com/oauth2/authorize",
	"token_count: 12345678901234567890",
	"https://gateway.example.test:8443/v1/chat?model=faux-1&stream=true",
	'{"type":"invalid_request_error","param":"model","max_tokens":4096} request id: req_011CUxFIXTURE',
	"model us.anthropic.claude-opus-4-5-20251101-v1:0, gpt-6.1-sol, task-12345678",
	"tasks-abcdefghijk /srv/risk-assessment-v2 disk-cache-directory-1234 /opt/AKIA_notes",
	`x%41${sk} x%5F${sk} x%GG${sk}`,
];

function failedMessage(errorMessage: string, stopReason: AssistantMessage["stopReason"] = "error"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		errorMessage,
		timestamp: 0,
	};
}

describe("redactSecrets", () => {
	for (const [label, text, leaked] of REDACTED_SHAPES) {
		it(`redacts ${label}`, () => {
			const redacted = redactSecrets(text);
			expect(redacted).toContain("[REDACTED]");
			expect(redacted).not.toContain(leaked);
			expect(redactSecrets(redacted)).toBe(redacted);
		});
	}

	for (const text of READABLE_TEXT) {
		it(`keeps ${text.slice(0, 40)} readable`, () => {
			expect(redactSecrets(text)).toBe(text);
		});
	}

	it("uses the caller's replacement", () => {
		expect(redactSecrets(`api_key=${secret}`, "[redacted]")).toBe("api_key=[redacted]");
	});

	it("keeps the URL around a credential found inside a token", () => {
		expect(redactSecrets(`https://${ghp}@github.com/o/r.git`)).toBe("https://[REDACTED]@github.com/o/r.git");
		expect(redactSecrets(`/v1/keys/${sk}`)).toBe("/v1/keys/[REDACTED]");
	});

	it("redacts a strict value up to its closing quote or field delimiter, keeping the structure", () => {
		expect(redactSecrets('password: "Hunter2!xyz9", next')).toBe('password: "[REDACTED]", next');
		expect(redactSecrets("password=p@ss:word123&model=faux-1")).toBe("password=[REDACTED]&model=faux-1");
		expect(redactSecrets(json({ password: 'a"b c', model: "faux-1" }))).toBe(
			json({ password: "[REDACTED]", model: "faux-1" }),
		);
	});
});

describe("sanitizeProviderErrorMessage", () => {
	const modelNotFound = `400 {"code":"model_not_found","message":"unknown provider for model faux-1"} x-api-key: ${secret}`;

	// senpi#4283: capture freezes metadata at push time, so later sanitization cannot repair leaked records.
	it("redacts streamed provider errors before capture freezes their persisted bytes", async () => {
		const stream = new AssistantMessageEventStream({ captureBlocks: true });
		const records = assistantRecords(stream);
		const partial = failedMessage(modelNotFound);
		const start = { type: "start", partial } as const;
		stream.push(start);
		const terminal = { type: "error", reason: "error", error: partial } as const;
		stream.push(terminal);
		stream.end();
		const captured = [];
		for await (const event of records) {
			const capture = getAssistantCapture(event);
			expect(capture).toBeDefined();
			expect(capture?.message?.errorMessage).toContain("[REDACTED]");
			expect(capture?.message?.errorCause).toEqual({ type: "model_config", model: "faux/faux-1" });
			captured.push({ event, capture });
		}
		expect(captured).toHaveLength(2);
		const persisted = JSON.stringify(captured);
		expect(persisted).toContain("[REDACTED]");
		expect(persisted).not.toContain(secret);
	});

	it("rejects post-done pushes before capture or message mutation", async () => {
		const stream = new AssistantMessageEventStream({ captureBlocks: true });
		const records = assistantRecords(stream);
		const message = failedMessage("finished", "stop");
		const done = { type: "done", reason: "stop", message } as const;
		stream.push(done);
		const partial = failedMessage(modelNotFound);
		const late = { type: "start", partial } as const;
		stream.push(late);
		expect(getAssistantCapture(late)).toBeUndefined();
		expect(partial.errorMessage).toBe(modelNotFound);
		expect(partial.errorCause).toBeUndefined();
		expect(await stream.result()).toBe(message);
		const observed = [];
		for await (const event of records) observed.push(event);
		expect(observed).toEqual([done]);
	});

	it("classifies a model configuration error on the raw text, then keeps only the redacted text", () => {
		const message = failedMessage(modelNotFound);
		sanitizeProviderErrorMessage(message);
		expect(message.errorCause).toEqual({ type: "model_config", model: "faux/faux-1" });
		expect(message.errorMessage).toContain("model_not_found");
		expect(message.errorMessage).not.toContain(secret);
	});

	for (const stopReason of ["aborted", "stop"] as const) {
		it(`does not classify a ${stopReason} message whose text mentions model_not_found`, () => {
			const message = failedMessage(modelNotFound, stopReason);
			sanitizeProviderErrorMessage(message);
			expect(message.errorCause).toBeUndefined();
			expect(message.errorMessage).not.toContain(secret);
		});
	}
});
