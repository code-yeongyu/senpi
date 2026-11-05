// Every secret shape a provider or gateway can echo in an error body, generated across key spellings, quoting and
// containers, plus the exact inputs a review found leaking. Fixture secrets are assembled at runtime and
// low-entropy so secret scanners never read them as real keys.

export interface SecretCell {
	readonly name: string;
	readonly secret: string;
	readonly text: string;
}

const secretFor = (index: number): string => `zzfixture${String(index).padStart(4, "0")}valueQ`;

// Key spellings: case, "-", "_", ".", compound prefixes and the header names gateways echo.
const KEY_SPELLINGS: readonly string[] = [
	"api_key",
	"api-key",
	"API-KEY",
	"Api.Key",
	"apikey",
	"x-api-key",
	"X-Api-Key",
	"x-goog-api-key",
	"key",
	"token",
	"access_token",
	"session_token",
	"openai_api_key",
	"OPENAI_API_KEY",
	"aws_secret_access_key",
	"private_key",
	"client_secret",
	"password",
	"Authorization",
	"Cookie",
	"Set-Cookie",
	// Numbered slots, qualifiers and a field named bearer (senpi#4283 round-6 review).
	"OPENAI_API_KEY_2",
	"token2",
	"x-api-key-1",
	"api_key_value",
	"apiKeyId",
	"bearer",
];

function valueFor(key: string, secret: string): string {
	if (key === "Authorization") return `Bearer ${secret}`;
	if (key === "Cookie") return `session=${secret}; theme=dark`;
	if (key === "Set-Cookie") return `sid=${secret}; Path=/; HttpOnly`;
	return secret;
}

const json = (value: unknown): string => JSON.stringify(value);

const CONTAINERS: readonly (readonly [label: string, render: (key: string, value: string) => string])[] = [
	["header line", (key, value) => `${key}: ${value}`],
	["double-quoted header value", (key, value) => `${key}: "${value}"`],
	["single-quoted header value", (key, value) => `${key}: '${value}'`],
	["backtick-quoted header value", (key, value) => `${key}: \`${value}\``],
	["JSON", (key, value) => json({ [key]: value })],
	["nested JSON", (key, value) => json({ error: { request: { headers: { [key]: value } } } })],
	["JSON array value", (key, value) => json({ headers: { [key]: [value] } })],
	["escaped JSON", (key, value) => json({ message: json({ [key]: value }) })],
	["doubly escaped JSON", (key, value) => json({ body: json({ message: json({ [key]: value }) }) })],
	["typographic-quoted JSON", (key, value) => `{\u201C${key}\u201D: \u201C${value}\u201D}`],
	["full-width colon", (key, value) => `${key}\uFF1A ${value}`],
	["XML element", (key, value) => `<${key}>${value}</${key}>`],
	["HTML-escaped JSON", (key, value) => `{&quot;${key}&quot;: &quot;${value}&quot;}`],
	["Go map", (key, value) => `map[${key}:[${value}] Content-Type:[application/json]]`],
	["Python repr", (key, value) => `{'${key}': '${value}', 'model': 'faux-1'}`],
	[
		"URL query",
		(key, value) =>
			`https://gateway.example.test/v1/chat?model=faux-1&${key}=${encodeURIComponent(value)}&stream=true`,
	],
	["form body", (key, value) => `model=faux-1&${key}=${encodeURIComponent(value)}&stream=true`],
];

// Credential-shaped values recognized by their prefix wherever they appear, under a name that says nothing.
const PREFIXED_SECRETS: readonly (readonly [label: string, secret: string])[] = [
	["sk-", `sk-${"proj"}FIXTURE0006`],
	["sk-ant-", `sk-${"ant-api03-"}FIXTURE0007`],
	["ghp_", `ghp_${"FIXTURE".repeat(3)}0008`],
	["github_pat_", `github_pat_${"FIXTURE".repeat(3)}_0009`],
	["AKIA", `AKIA${"FIXTURE"}000000010`],
	["AIza", `AIza${"FIXTURE".repeat(5)}0011`],
	["JWT", [`eyJ${"hbGciOiJub25lIn0"}`, `eyJ${"zdWIiOiJmaXh0dXJlIn0"}`, `Zml4dHVyZS1zaWc${"x"}`].join(".")],
	["gsk_", `gsk_${"FIXTURE".repeat(3)}0012`],
	["xai-", `xai-${"FIXTURE".repeat(3)}0013`],
	["hf_", `hf_${"FIXTURE".repeat(3)}0014`],
	["rk_live_", `rk_${"live_"}${"FIXTURE".repeat(3)}0015`],
	["xoxb-", `xox${"b-"}${"FIXTURE".repeat(2)}-0016`],
];

const named: SecretCell[] = KEY_SPELLINGS.flatMap((key, keyIndex) =>
	CONTAINERS.map(([label, render], containerIndex) => {
		const secret = secretFor(keyIndex * CONTAINERS.length + containerIndex);
		return { name: `${key} in ${label}`, secret, text: render(key, valueFor(key, secret)) };
	}),
);

const prefixed: SecretCell[] = PREFIXED_SECRETS.flatMap(([prefix, secret]) =>
	CONTAINERS.map(([label, render]) => ({
		name: `bare ${prefix} in ${label}`,
		secret,
		text: render("detail", `rejected ${secret}`),
	})),
);

// The exact inputs the senpi#4283 delta review saw leak.
const reviewSecret = ["zzsecretzz", "123456"].join("");
const REVIEW_CELLS: readonly SecretCell[] = [
	{ name: "review: x-api-key header on the event stream", secret: reviewSecret, text: `x-api-key: ${reviewSecret}` },
	{ name: "review: Python repr api_key", secret: secretFor(9001), text: `{'api_key': '${secretFor(9001)}'}` },
	{ name: "review: quoted header value", secret: secretFor(9002), text: `api-key: "${secretFor(9002)}"` },
	{ name: "review: header array", secret: secretFor(9003), text: json({ "x-api-key": [secretFor(9003)] }) },
	{ name: "review: Go header map", secret: secretFor(9004), text: `map[X-Api-Key:[${secretFor(9004)}]]` },
	{
		name: "review: Google ?key=",
		secret: secretFor(9005),
		text: `https://generativelanguage.example.test/v1beta/models?key=${secretFor(9005)}`,
	},
	{
		name: "review: Google ?KEY=",
		secret: secretFor(9006),
		text: `https://generativelanguage.example.test/v1beta/models?KEY=${secretFor(9006)}`,
	},
	{ name: "review: openai_api_key", secret: secretFor(9007), text: `openai_api_key=${secretFor(9007)}` },
	{ name: "review: private_key", secret: secretFor(9008), text: `private_key: ${secretFor(9008)}` },
	{
		name: "review: aws_secret_access_key",
		secret: secretFor(9009),
		text: `aws_secret_access_key = ${secretFor(9009)}`,
	},
	{
		name: "review: doubly escaped JSON",
		secret: secretFor(9010),
		text: json(json(json({ "api-key": secretFor(9010) }))),
	},
	{
		name: "review: bare AIza key",
		secret: PREFIXED_SECRETS[5]?.[1] ?? "",
		text: `key ${PREFIXED_SECRETS[5]?.[1] ?? ""} rejected`,
	},
];

// The inputs the delta review of fea33d95c2 saw leak: cookie pairs after a short first value, nested credential
// objects, URL userinfo and an Azure SAS signature.
const ROUND_4_CELLS: readonly SecretCell[] = [
	{ name: "review: second cookie pair", secret: secretFor(9101), text: `Cookie: a=1; __cf_bm=${secretFor(9101)}` },
	{
		name: "review: set-cookie array",
		secret: secretFor(9102),
		text: json({ "set-cookie": ["a=1", `sid=${secretFor(9102)}`] }),
	},
	{
		name: "review: nested credentials object",
		secret: secretFor(9103),
		text: json({ error: { credentials: { value: secretFor(9103) } } }),
	},
	{
		name: "review: escaped nested credentials object",
		secret: secretFor(9104),
		text: json({ message: json({ credentials: { type: "service", value: secretFor(9104) } }) }),
	},
	{
		name: "review: URL userinfo",
		secret: secretFor(9105),
		text: `https://user:${secretFor(9105)}@gateway.example.test/v1`,
	},
	{
		name: "review: Azure SAS signature",
		secret: secretFor(9106),
		text: `https://acct.blob.example.test/c/b?sv=2024-11-04&sr=b&sig=${secretFor(9106)}`,
	},
];

// The inputs the delta review of 75bce8e879 saw leak: a name past the old length window, and short values under a
// password or authorization name.
const ROUND_6_CELLS: readonly SecretCell[] = [
	{
		name: "review: a 130-character name",
		secret: secretFor(9201),
		text: json({ [`${"a".repeat(130)}_api_key`]: secretFor(9201) }),
	},
	{
		name: "review: a long dotted authorization path",
		secret: secretFor(9202),
		text: `request.headers.${"x".repeat(120)}.authorization: ${secretFor(9202)}`,
	},
	{ name: "review: a short password", secret: "hunter2-shrt", text: json({ password: "hunter2-shrt" }) },
	{
		name: "review: a short Basic credential",
		secret: ["dXNl", "cjpw", "YXNz"].join(""),
		text: `Authorization: Basic ${["dXNl", "cjpw", "YXNz"].join("")}`,
	},
];

// The inputs the delta review of 4cf2ef5bfa saw leak: credential shapes inside a token (git remote and proxy userinfo,
// URL path segments, joined values), and strict values past their first token.
const ghp = PREFIXED_SECRETS[2]?.[1] ?? "";
const sk = PREFIXED_SECRETS[0]?.[1] ?? "";
const skAnt = PREFIXED_SECRETS[1]?.[1] ?? "";
const akia = PREFIXED_SECRETS[4]?.[1] ?? "";
const jwt = PREFIXED_SECRETS[6]?.[1] ?? "";
const ROUND_8_CELLS: readonly SecretCell[] = [
	// Round 9 (senpi#4283): decoded token punctuation is a word boundary too.
	{ name: "review: encoded git remote userinfo", secret: ghp, text: `https%3A%2F%2F${ghp}%40github.com` },
	{ name: "review: key after encoded /", secret: sk, text: `/v1%2F${sk}` },
	{ name: "review: JWT after encoded /", secret: jwt, text: `redirect=%2Fcb%2F${jwt}` },
	{ name: "review: key after encoded +", secret: sk, text: `x%2B${sk}` },
	{ name: "review: key after encoded ~", secret: sk, text: `x%7E${sk}` },
	{ name: "review: key after encoded -", secret: sk, text: `x%2D${sk}` },
	{ name: "review: key after encoded .", secret: sk, text: `x%2e${sk}` },
	{ name: "review: key after lowercase encoded /", secret: sk, text: `x%2f${sk}` },
	{ name: "review: token as git remote userinfo", secret: ghp, text: `https://${ghp}@github.com/o/r.git` },
	{
		name: "review: git remote user:token userinfo",
		secret: ghp,
		text: `git push https://x-access-token:${ghp}@github.com/o/r.git`,
	},
	{
		name: "review: git remote oauth2:password userinfo",
		secret: secretFor(9301),
		text: `remote: https://oauth2:${secretFor(9301)}@gitlab.example.test/o/r.git`,
	},
	{ name: "review: key in a URL path segment", secret: sk, text: `GET /v1/keys/${sk} 401` },
	{ name: "review: key joined with +", secret: skAnt, text: `x+${skAnt}` },
	{ name: "review: AWS key id after /", secret: akia, text: `see /${akia}` },
	{ name: "review: JWT in a URL path", secret: jwt, text: `callback /cb/${jwt}` },
	{ name: "review: key as proxy userinfo", secret: sk, text: `https://${sk}@proxy.example.test` },
	{ name: "review: token after user@", secret: ghp, text: `ssh deploy@${ghp}` },
	{ name: "review: key after ~/", secret: sk, text: `~/${sk}` },
	{ name: "review: password with !", secret: "zzTailB01", text: 'password: "Hunter2!zzTailB01"' },
	{ name: "review: password with @ and :", secret: "zzTailB02", text: "password=p@zzTailB02:word123" },
	{ name: "review: non-ASCII password", secret: "zzTailB03", text: json({ password: "p\u00e4ssw\u00f6rdzzTailB03" }) },
	{
		name: "review: password with spaces in quotes",
		secret: "zzTailB04",
		text: json({ password: "abc def zzTailB04" }),
	},
];

export const SECRET_CELLS: readonly SecretCell[] = [
	...REVIEW_CELLS,
	...ROUND_4_CELLS,
	...ROUND_6_CELLS,
	...ROUND_8_CELLS,
	// Nested lexical units must survive the full provider -> session -> sink path, not just the exported helpers.
	...[2, 3].flatMap((depth) => {
		const e = (hex: string): string => `%${"25".repeat(depth - 1)}${hex}`;
		return [
			{
				name: `review: depth ${depth} encoded remote`,
				secret: ghp,
				text: `https${e("3A")}${e("2f")}${e("2F")}${ghp}${e("40")}github.com`,
			},
			{ name: `review: depth ${depth} encoded key`, secret: sk, text: `x${e("2f")}${sk}` },
			{ name: `review: depth ${depth} encoded JWT`, secret: jwt, text: `redirect%3D${e("2F")}cb${e("2f")}${jwt}` },
			{ name: `review: depth ${depth} encoded AWS`, secret: akia, text: `x${e("2F")}${akia}` },
			{
				name: `review: depth ${depth} encoded generic value`,
				secret: secretFor(9400 + depth),
				text: `api_key${e("3d")}${secretFor(9400 + depth)}`,
			},
		];
	}),
	...named,
	...prefixed,
];

// Names that merely contain a credential word, with values a name-substring rule would mangle.
export const READABLE_NAMED_VALUES: readonly string[] = [
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
];

// Diagnostic text that must stay readable: model ids, error codes, request ids, token counts.
export const READABLE_PROVIDER_TEXT =
	'{"type":"invalid_request_error","param":"model","max_tokens":4096} request id: req_011CUxFIXTURE, model us.anthropic.claude-opus-4-5-20251101-v1:0, gpt-6.1-sol, task-12345678';
