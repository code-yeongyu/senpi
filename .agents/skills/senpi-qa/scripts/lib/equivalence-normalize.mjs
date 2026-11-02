// EQ normalizer (plan §6.2): the one rule set every fused-equivalence observation goes through before comparison.
//
// - one-to-one first-occurrence token maps per id namespace (`uuid` by shape anywhere, `id` by key: a value under an id
//   key that is not a bare uuid is one id, `<pid>:<uuid>` owner ids included);
// - timestamps become ranks (ISO and filename-style datetimes and dates inside strings, epoch numbers under time keys):
//   each timestamp becomes its rank of appearance inside its namespace, the key that carries it qualified by its parent
//   key (`<ts:entry.timestamp:3>` is the third entry timestamp). Wall-clock values themselves are never compared:
//   neighbouring events land in the same millisecond or not by chance, and a value assigned before an event is emitted
//   can trail one emitted after it, so even their relative order is a race; event and entry order are compared directly;
// - durations and resource measurements are dropped (duration/elapsed/latency/queued keys, kernel memory byte counts);
// - only run-scoped prefixes are replaced: the roots the harness allocates (sandbox, checkout, fake-server origin) and
//   the host facts the CLI renders about the machine it runs on;
// - nothing else is masked: every other string, number, key and array order is compared as produced.

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const PURE_UUID = new RegExp("^" + UUID.source + "$", "i");
// 2026-10-28T06:44:01.898Z, 2026-10-28T06-44-01-898Z (session file names), 2026-10-28 (a bare date).
const DATETIME = /\d{4}-\d{2}-\d{2}(?:T(\d{2})[:-](\d{2})[:-](\d{2})(?:[.-](\d{1,6}))?Z?)?/g;
const ID_KEYS = new Set([
	"id",
	"parentId",
	"leafId",
	"entryId",
	"targetId",
	"fromId",
	"firstKeptEntryId",
	"sessionId",
	"rootSessionId",
	"parentSessionId",
	"instanceId",
	"messageId",
	"requestId",
	"responseId",
	"toolCallId",
	"runId",
	"cellId",
	"taskId",
	"ownerId",
]);
/** Ids shorter than this are only tokenized under their key, never searched for inside other text. */
const EMBEDDED_ID_MIN = 6;
/**
 * A pure-hex id this long is generated, never a word: session entry ids are `Math.random().toString(16).slice(2, 10)`,
 * so a run can mint one with no decimal digit at all (`babaacde`) and it still has to normalize wherever it is embedded.
 */
const GENERATED_HEX_ID_MIN = 8;
const PURE_HEX_ID = /^[0-9a-f]+$/i;
const TIME_KEY = /^(ts|at|since|time|timestamp|date)$|(Time|At|Timestamp|Since)(Ms)?$/;
const DURATION_KEY =
	/^(duration|elapsed|latency|generation|ttft|firstToken|waited|took|queued)(Ms|Us|Ns|Sec|Seconds|_ms)?$|(Duration|Elapsed|Latency|Generation|Ttft|FirstToken|Waited|Took|Queued)(Ms|Us|Ns|Sec|Seconds)?$/;
/** Measured resource quantities (a kernel's live heap after a cell), dropped like durations. */
const MEASUREMENT_KEY = /^(liveBytes|rssBytes|heapUsedBytes|heapTotalBytes|externalBytes)$/;
// Epoch numbers under a time key: seconds or milliseconds between 2001 and 2286.
const EPOCH_MS_MIN = 1e12;
const EPOCH_MS_MAX = 1e13;
const EPOCH_S_MIN = 1e9;
const EPOCH_S_MAX = 1e10;

/** Epoch ms of a DATETIME match, or undefined when the match is not a valid date. */
function datetimeEpoch(text) {
	const iso = text.replace(
		/T(\d{2})-(\d{2})-(\d{2})(?:-(\d{1,6}))?/,
		(_m, h, mi, s, f) => `T${h}:${mi}:${s}${f ? `.${f}` : ""}`,
	);
	const ms = Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso.endsWith("Z") ? iso : `${iso}Z`);
	return Number.isFinite(ms) ? ms : undefined;
}

function epochOfNumber(value) {
	if (!Number.isFinite(value)) return undefined;
	if (value >= EPOCH_MS_MIN && value < EPOCH_MS_MAX) return value;
	if (value >= EPOCH_S_MIN && value < EPOCH_S_MAX) return value * 1000;
	return undefined;
}

/**
 * @param {{ roots?: Array<{ prefix: string, token: string }>, hostFacts?: Array<{ value: string, token: string }> }} [options]
 * `roots` are run-scoped prefixes (an empty prefix is ignored); `hostFacts` are the machine facts the CLI renders.
 * Both are replaced longest first, everywhere they occur in a string.
 */
export function createNormalizer({ roots = [], hostFacts = [] } = {}) {
	const literals = [
		...roots.map((r) => ({ text: r.prefix, token: r.token })),
		...hostFacts.map((f) => ({ text: f.value, token: f.token })),
	]
		.filter((entry) => typeof entry.text === "string" && entry.text.length > 0)
		.sort((a, b) => b.text.length - a.text.length);

	const replaceLiterals = (text) => literals.reduce((out, { text: from, token }) => out.split(from).join(token), text);

	/** Normalize one observation; token maps and ranks are scoped to this call. */
	return function normalize(value) {
		const keyedIds = [];
		walkValue(
			value,
			() => "",
			(namespace, raw) => {
				if (namespace === "id") keyedIds.push(raw);
				return "";
			},
		);
		const appearances = new Map();
		const rank = (namespace) => {
			appearances.set(namespace, (appearances.get(namespace) ?? 0) + 1);
			return appearances.get(namespace);
		};
		const maps = { uuid: new Map(), id: new Map() };
		const token = (namespace, raw) => {
			const map = maps[namespace];
			if (!map.has(raw)) map.set(raw, `<${namespace}:${map.size + 1}>`);
			return map.get(raw);
		};
		// An id seen under an id key is the same id wherever else it is embedded (`turnKey: "1:<entry id>"`): it gets the
		// same token there. Tokens are numbered by first keyed occurrence. Only generated-looking values are searched for in
		// text, so a word-like id never masks prose: a value carrying a decimal digit, or one that is pure hex at
		// GENERATED_HEX_ID_MIN or more characters (`babaacde`, `d1303e80`). A digitless value below that length stays
		// keyed-only, so `facade` in prose is untouched.
		for (const raw of keyedIds) token("id", raw);
		const embedded = [...maps.id.keys()]
			.filter(
				(raw) =>
					raw.length >= EMBEDDED_ID_MIN &&
					(/\d/.test(raw) || (raw.length >= GENERATED_HEX_ID_MIN && PURE_HEX_ID.test(raw))),
			)
			.sort((a, b) => b.length - a.length);
		const replaceIds = (text) =>
			embedded.reduce((out, raw) => (out.includes(raw) ? out.split(raw).join(maps.id.get(raw)) : out), text);
		return walkValue(value, (_epoch, namespace) => `<ts:${namespace}:${rank(namespace)}>`, token, replaceIds);
	};

	/**
	 * One traversal shared by the timestamp pass and the rewrite pass, so both see timestamps in the same order.
	 * `onTimestamp(epoch, namespace)` returns the replacement text; `onId(namespace, raw)` returns an id token. A timestamp's
	 * namespace is `<parent key>.<key>` (an array element takes the array's key; `text` for an object key).
	 */
	function walkValue(root, onTimestamp, onId, replaceIds = (text) => text) {
		const rewriteString = (text, key) =>
			replaceIds(replaceLiterals(text))
				.replace(DATETIME, (match) => {
					const epoch = datetimeEpoch(match);
					return epoch === undefined ? match : onTimestamp(epoch, key ?? "text");
				})
				.replace(UUID, (match) => onId("uuid", match.toLowerCase()));
		const walk = (node, key, parent) => {
			const namespace = parent === undefined ? (key ?? "text") : `${parent}.${key ?? "text"}`;
			if (typeof node === "string") {
				if (key !== undefined && ID_KEYS.has(key) && !PURE_UUID.test(node)) return onId("id", node);
				return rewriteString(node, namespace);
			}
			if (typeof node === "number") {
				const epoch = key !== undefined && TIME_KEY.test(key) ? epochOfNumber(node) : undefined;
				return epoch === undefined ? node : onTimestamp(epoch, namespace);
			}
			if (Array.isArray(node)) return node.map((item) => walk(item, undefined, key ?? parent));
			if (node && typeof node === "object") {
				const out = {};
				for (const [childKey, child] of Object.entries(node)) {
					if (DURATION_KEY.test(childKey) || MEASUREMENT_KEY.test(childKey)) continue;
					const outKey = rewriteString(childKey);
					out[outKey] = walk(child, childKey, key ?? parent);
				}
				return out;
			}
			return node;
		};
		return walk(root, undefined, undefined);
	}
}

/**
 * Structural diff of two normalized values: a list of `{ path, golden, actual }` rows, empty when equal.
 * Array order and object key sets are part of the comparison; key order inside an object is not.
 */
export function diffNormalized(golden, actual, path = "$", rows = []) {
	if (Object.is(golden, actual)) return rows;
	const bothArrays = Array.isArray(golden) && Array.isArray(actual);
	const bothObjects =
		golden &&
		actual &&
		typeof golden === "object" &&
		typeof actual === "object" &&
		!Array.isArray(golden) &&
		!Array.isArray(actual);
	if (bothArrays) {
		const length = Math.max(golden.length, actual.length);
		for (let index = 0; index < length; index++) {
			if (index >= golden.length) rows.push({ path: `${path}[${index}]`, golden: undefined, actual: actual[index] });
			else if (index >= actual.length)
				rows.push({ path: `${path}[${index}]`, golden: golden[index], actual: undefined });
			else diffNormalized(golden[index], actual[index], `${path}[${index}]`, rows);
		}
		return rows;
	}
	if (bothObjects) {
		for (const key of new Set([...Object.keys(golden), ...Object.keys(actual)])) {
			diffNormalized(golden[key], actual[key], `${path}.${key}`, rows);
		}
		return rows;
	}
	rows.push({ path, golden, actual });
	return rows;
}
