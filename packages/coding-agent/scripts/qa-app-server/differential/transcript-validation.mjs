export const DIRECTIONS = new Set(["client->server", "server->client"]);

export function invalidTranscriptReasons(records) {
	let previousSeq = 0;
	return records.map((record, index) => {
		const reason = invalidRecordReason(record, index, previousSeq);
		if (isObject(record) && Number.isSafeInteger(record.seq) && record.seq > previousSeq) previousSeq = record.seq;
		return reason;
	});
}

export function sequenceDifference(index, oracle, candidate) {
	return {
		index,
		path: "seq",
		kind: "sequence",
		oracle,
		candidate,
		classification: "parity-regression",
		rationale: "Corresponding transcript sequence numbers differ and sequence order is never allowlisted.",
	};
}

function invalidRecordReason(record, index, previousSeq) {
	if (!isObject(record)) return `Transcript record ${index} is not an object.`;
	if (!Number.isSafeInteger(record.seq) || record.seq <= 0) {
		return `Transcript sequence is not a positive integer at index ${index}.`;
	}
	if (record.seq <= previousSeq) return `Transcript sequence is not strictly increasing at index ${index}.`;
	if (!DIRECTIONS.has(record.direction)) return `Transcript direction is invalid at index ${index}.`;
	if (typeof record.target !== "string" || record.target.length === 0) return `Transcript target is missing at index ${index}.`;
	if (!Object.hasOwn(record, "frame")) return `Transcript frame is missing at index ${index}.`;
	return undefined;
}

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
