export type JsonRecord = Readonly<Record<string, unknown>>;
export type RpcRequest = JsonRecord & { readonly id: number; readonly method: string };
export type RpcResponse = JsonRecord & { readonly id: number };
export type Exchange = { readonly method: string; readonly request: RpcRequest; readonly response: RpcResponse };

type MethodExample = { readonly request: JsonRecord; readonly response: JsonRecord };

export const requiredMethods = [
	"initialize",
	"model/list",
	"remoteControl/status/read",
	"thread/start",
	"thread/resume",
	"thread/list",
	"thread/loaded/list",
	"thread/read",
	"thread/name/set",
	"turn/interrupt",
	"turn/steer",
	"turn/start",
	"thread/fork",
	"thread/archive",
	"thread/delete",
	"thread/unsubscribe",
	"thread/search",
] as const;

export function validateDocs(markdown: string, liveExchanges: readonly Exchange[]): void {
	const examples = extractMethodExamples(markdown);
	for (const method of requiredMethods) {
		const documented = examples.get(method);
		if (!documented) {
			throw new Error(`missing documented live example for ${method}`);
		}
		const live = liveExchanges.find((exchange) => exchange.method === method);
		if (!live) {
			throw new Error(`missing live exchange for ${method}`);
		}
		compareRequest(method, documented.request, live.request);
		compareResponse(method, documented.response, live.response);
		console.log(`PASS_${method.replace(/\//g, "_")}=status+keys`);
	}
}

export function stringAt(record: JsonRecord, path: readonly string[]): string {
	let current: unknown = record;
	for (const key of path) {
		current = recordValue(current, key)[key];
	}
	if (typeof current !== "string") {
		throw new Error(`expected string at ${path.join(".")}`);
	}
	return current;
}

export function withNumberId(record: JsonRecord, label: string): RpcResponse {
	if (typeof record.id !== "number") {
		throw new Error(`${label} id is not a number`);
	}
	return { ...record, id: record.id };
}

export function parseRecord(text: string, label: string): JsonRecord {
	return recordValue(JSON.parse(text), label);
}

function extractMethodExamples(markdown: string): Map<string, MethodExample> {
	const sections = markdown.split(/^### /m).slice(1);
	const examples = new Map<string, MethodExample>();
	for (const section of sections) {
		const headingEnd = section.indexOf("\n");
		if (headingEnd === -1) continue;
		const method = section.slice(0, headingEnd).trim();
		const blocks = [...section.matchAll(/```json\s*([\s\S]*?)```/g)].map((match) => parseBlock(match, method));
		if (blocks.length >= 2) {
			examples.set(method, { request: blocks[0], response: blocks[1] });
		}
	}
	return examples;
}

function parseBlock(match: RegExpMatchArray, method: string): JsonRecord {
	const json = match[1];
	if (json === undefined) {
		throw new Error(`empty JSON block for ${method}`);
	}
	return parseRecord(json.trim(), `documented ${method} example`);
}

function compareRequest(method: string, documented: JsonRecord, live: RpcRequest): void {
	if (documented.method !== live.method || documented.method !== method) {
		throw new Error(`${method} documented request method does not match live request`);
	}
	compareKeys(`${method} request`, documented, live);
	compareOptionalRecordKeys(`${method} params`, documented.params, live.params);
}

function compareResponse(method: string, documented: JsonRecord, live: RpcResponse): void {
	if (documented.id !== live.id) {
		throw new Error(`${method} response id mismatch`);
	}
	const documentedStatus = responseStatus(documented);
	const liveStatus = responseStatus(live);
	if (documentedStatus !== liveStatus) {
		throw new Error(`${method} documented ${documentedStatus} but live returned ${liveStatus}`);
	}
	compareKeys(`${method} response`, documented, live);
	compareKeys(
		`${method} ${documentedStatus}`,
		responseBody(documented, documentedStatus),
		responseBody(live, liveStatus),
	);
	if (documentedStatus === "error") {
		compareErrorCode(method, responseBody(documented, "error"), responseBody(live, "error"));
	}
	compareNestedResultKeys(method, documented, live);
}

function compareErrorCode(method: string, documented: JsonRecord, live: JsonRecord): void {
	if (documented.code !== live.code) {
		throw new Error(`${method} error code differs: doc=${String(documented.code)} live=${String(live.code)}`);
	}
}

function compareNestedResultKeys(method: string, documented: JsonRecord, live: JsonRecord): void {
	if (!("result" in documented) || !("result" in live)) return;
	const documentedResult = recordValue(documented.result, `${method} documented result`);
	const liveResult = recordValue(live.result, `${method} live result`);
	compareOptionalRecordKeys(`${method} result.thread`, documentedResult.thread, liveResult.thread);
	if (method === "thread/loaded/list") {
		compareOptionalArrayItemValues(`${method} result.data[0]`, documentedResult.data, liveResult.data);
	} else {
		compareOptionalArrayItemKeys(`${method} result.data[0]`, documentedResult.data, liveResult.data);
	}
	compareOptionalRecordKeys(`${method} result.turn`, documentedResult.turn, liveResult.turn);
}

function compareOptionalRecordKeys(label: string, documented: unknown, live: unknown): void {
	if (documented === undefined && live === undefined) return;
	compareKeys(label, recordValue(documented, `${label} documented`), recordValue(live, `${label} live`));
}

function compareOptionalArrayItemKeys(label: string, documented: unknown, live: unknown): void {
	if (!Array.isArray(documented) && !Array.isArray(live)) return;
	if (!Array.isArray(documented) || !Array.isArray(live)) {
		throw new Error(`${label} is not an array in both responses`);
	}
	if (documented.length === 0 && live.length === 0) return;
	const documentedFirst = arrayFirstRecord(documented, `${label} documented`);
	const liveFirst = arrayFirstRecord(live, `${label} live`);
	compareKeys(label, documentedFirst, liveFirst);
}

function compareOptionalArrayItemValues(label: string, documented: unknown, live: unknown): void {
	if (!Array.isArray(documented) && !Array.isArray(live)) return;
	if (!Array.isArray(documented) || !Array.isArray(live) || documented.length === 0 || live.length === 0) {
		throw new Error(`${label} is not present in both arrays`);
	}
	if (typeof documented[0] !== "string" || typeof live[0] !== "string") {
		throw new Error(`${label} is not a string in both arrays`);
	}
}

function compareKeys(label: string, documented: JsonRecord, live: JsonRecord): void {
	const documentedKeys = Object.keys(documented).sort();
	const liveKeys = Object.keys(live).sort();
	if (!arraysEqual(documentedKeys, liveKeys)) {
		throw new Error(`${label} keys differ: doc=${documentedKeys.join(",")} live=${liveKeys.join(",")}`);
	}
}

function responseStatus(response: JsonRecord): "result" | "error" {
	if ("result" in response) return "result";
	if ("error" in response) return "error";
	throw new Error(`response has neither result nor error: ${JSON.stringify(response)}`);
}

function responseBody(response: JsonRecord, status: "result" | "error"): JsonRecord {
	return recordValue(response[status], `response ${status}`);
}

function arrayFirstRecord(value: unknown, label: string): JsonRecord {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`${label} is not a non-empty array`);
	}
	return recordValue(value[0], label);
}

function recordValue(value: unknown, label: string): JsonRecord {
	if (!isRecord(value)) {
		throw new Error(`${label} is not an object`);
	}
	return value;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
