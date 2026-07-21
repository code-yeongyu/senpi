const SERVER_ID_KEYS = new Set([
	"conversationId",
	"installationId",
	"itemId",
	"responseId",
	"rolloutId",
	"threadId",
	"turnId",
]);
const TIMESTAMP_KEYS = new Set([
	"completedAt",
	"createdAt",
	"created_at",
	"emittedAtMs",
	"startedAt",
	"timestamp",
	"updatedAt",
	"updated_at",
]);
const GENERATED_ID_PATTERN = /^(?:[0-9a-f]{8}-[0-9a-f-]{27,}|(?:thread|turn|item|resp|response)[-_][a-z0-9_-]+)$/i;

export function normalizeTranscript(records, options = {}) {
	const serverIds = new Map();
	const serverRequestIds = new Map();
	const timestamps = new Map();
	const tempPaths = (options.tempPaths ?? [])
		.flatMap((value, index) =>
			(value.startsWith("/tmp/") ? [value, `/private${value}`] : [value]).map((alias) => ({
				value: alias,
				replacement: `<temp:${index + 1}>`,
			})),
		)
		.filter((entry) => entry.value.length > 0)
		.sort((left, right) => right.value.length - left.value.length);
	const tokens = [...(options.tokens ?? [])].filter((value) => value.length > 0).sort((left, right) => right.length - left.length);

	const mapStable = (map, value, label) => {
		const key = valueKey(value);
		const existing = map.get(key);
		if (existing !== undefined) return existing;
		const replacement = `<${label}:${map.size + 1}>`;
		map.set(key, replacement);
		return replacement;
	};

	const normalizeString = (value) => {
		let normalized = value;
		for (const token of tokens) normalized = normalized.split(token).join("<token>");
		for (const tempPath of tempPaths) {
			normalized = normalized.split(tempPath.value).join(tempPath.replacement);
		}
		return normalized;
	};

	const normalizeValue = (value, key, depth) => {
		if (TIMESTAMP_KEYS.has(key) && (typeof value === "number" || typeof value === "string")) {
			return mapStable(timestamps, value, "timestamp");
		}
		if (typeof value === "string") {
			if (key === "userAgent") return "<server-user-agent>";
			if (SERVER_ID_KEYS.has(key) || (key === "id" && depth > 1 && GENERATED_ID_PATTERN.test(value))) {
				return mapStable(serverIds, value, "server-id");
			}
			return normalizeString(value);
		}
		if (Array.isArray(value)) return value.map((entry) => normalizeValue(entry, "", depth + 1));
		if (value !== null && typeof value === "object") {
			const normalized = {};
			for (const childKey of Object.keys(value).sort()) {
				normalized[childKey] = normalizeValue(value[childKey], childKey, depth + 1);
			}
			return normalized;
		}
		return value;
	};

	return records.map((record) => {
		const frame = normalizeValue(record.frame, "", 0);
		if (isObject(record.frame) && isObject(frame) && Object.hasOwn(record.frame, "id")) {
			const id = record.frame.id;
			if (record.direction === "server->client" && typeof record.frame.method === "string") {
				const replacement = mapStable(serverIds, id, "server-id");
				serverRequestIds.set(valueKey(id), replacement);
				frame.id = replacement;
			} else if (
				record.direction === "client->server" &&
				typeof record.frame.method !== "string" &&
				serverRequestIds.has(valueKey(id))
			) {
				frame.id = serverRequestIds.get(valueKey(id));
			}
		}
		return { seq: record.seq, direction: record.direction, target: record.target, frame };
	});
}

function valueKey(value) {
	return `${typeof value}:${String(value)}`;
}

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
