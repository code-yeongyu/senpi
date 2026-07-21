/**
 * Exact-parity scenarios retain the raw normalized JSONL receipts and compare a
 * deliberately narrow projection only where the plan pins an exact semantic:
 * lifecycle statuses, turn frame sequence, and approval decision ordering.
 * The projection never reorders frames or collapses duplicate notifications.
 */
export function projectLifecycle(records) {
	const requestMethods = new Map();
	const projected = [];
	for (const record of records) {
		const frame = record.frame;
		if (record.direction === "client->server" && isRequest(frame)) {
			requestMethods.set(key(frame.id), frame.method);
			if (frame.method === "initialize" || frame.method.startsWith("thread/")) {
				projected.push(project(record, { id: frame.id, method: frame.method }));
			}
			continue;
		}
		if (record.direction === "server->client" && isResponse(frame)) {
			const method = requestMethods.get(key(frame.id));
			if (method === undefined || (method !== "initialize" && !method.startsWith("thread/"))) continue;
			projected.push(project(record, { id: frame.id, ...responseStatus(frame) }));
			continue;
		}
		if (
			record.direction === "server->client" &&
			isNotification(frame) &&
			new Set(["thread/started", "thread/name/updated", "thread/archived", "thread/unarchived", "thread/deleted"]).has(
				frame.method,
			)
		) {
			projected.push(project(record, notificationStatus(frame)));
		}
	}
	return resequence(projected);
}

export function projectTurnLifecycle(records) {
	const projected = [];
	for (const record of records) {
		const frame = record.frame;
		if (record.direction === "client->server" && isRequest(frame)) {
			if (frame.method === "initialize" || frame.method === "thread/start" || frame.method.startsWith("turn/")) {
				projected.push(project(record, { id: frame.id, method: frame.method }));
			}
			continue;
		}
		if (record.direction === "server->client" && isResponse(frame)) {
			projected.push(project(record, { id: frame.id, ...responseStatus(frame) }));
			continue;
		}
		if (record.direction === "server->client" && isNotification(frame)) {
			if (frame.method === "turn/started" || frame.method === "turn/completed" || frame.method === "thread/status/changed") {
				projected.push(project(record, notificationStatus(frame)));
			}
		}
	}
	return resequence(projected);
}

export function projectApprovals(records) {
	const projected = [];
	for (const record of records) {
		const frame = record.frame;
		if (record.direction === "client->server" && isRequest(frame)) {
			if (frame.method === "initialize" || frame.method === "thread/start" || frame.method === "turn/start") {
				projected.push(project(record, { id: frame.id, method: frame.method }));
			}
			continue;
		}
		if (record.direction === "client->server" && isResponse(frame)) {
			projected.push(project(record, { id: frame.id, result: frame.result }));
			continue;
		}
		if (record.direction === "server->client" && isResponse(frame)) {
			projected.push(project(record, { id: frame.id, ...responseStatus(frame) }));
			continue;
		}
		if (record.direction === "server->client" && isNotification(frame)) {
			if (frame.method === "turn/started" || frame.method === "turn/completed" || frame.method === "serverRequest/resolved") {
				projected.push(project(record, notificationStatus(frame)));
			}
			continue;
		}
		if (record.direction === "server->client" && isRequest(frame)) {
			if (frame.method === "item/commandExecution/requestApproval") {
				projected.push(project(record, { id: frame.id, method: frame.method }));
			}
		}
	}
	return resequence(projected);
}

export function projectThreadHistory(records) {
	return projectMethodResponses(records, new Set(["thread/turns/list", "thread/items/list"]));
}

export function projectSearch(records) {
	return projectMethodResponses(records, new Set(["thread/search", "thread/searchOccurrences"]));
}

export function projectCapabilityGaps(records) {
	return projectMethodResponses(
		records,
		new Set([
			"remoteControl/client/list",
			"thread/goal/set",
			"account/read",
			"account/rateLimits/read",
			"account/usage/read",
		]),
	);
}

export function projectFuzzy(records) {
	return projectMethodResponses(
		records,
		new Set([
			"fuzzyFileSearch",
			"fuzzyFileSearch/sessionStart",
			"fuzzyFileSearch/sessionUpdate",
			"fuzzyFileSearch/sessionStop",
		]),
	);
}

export function projectCatalogs(records) {
	return projectMethodResponses(
		records,
		new Set([
			"model/list",
			"skills/list",
			"mcpServerStatus/list",
			"config/read",
			"configRequirements/read",
			"experimentalFeature/list",
			"permissionProfile/list",
			"remoteControl/status/read",
			"collaborationMode/list",
			"thread/metadata/update",
			"thread/settings/update",
			"thread/goal/get",
			"thread/goal/clear",
		]),
	);
}

function projectMethodResponses(records, methods) {
	const requestMethods = new Map();
	const projected = [];
	for (const record of records) {
		const frame = record.frame;
		if (record.direction === "client->server" && isRequest(frame)) {
			if (methods.has(frame.method)) {
				requestMethods.set(key(frame.id), frame.method);
				projected.push(project(record, { id: frame.id, method: frame.method }));
			}
			continue;
		}
		if (record.direction === "server->client" && isResponse(frame) && requestMethods.has(key(frame.id))) {
			projected.push(project(record, { id: frame.id, ...responseStatus(frame) }));
		}
	}
	return resequence(projected);
}

export function projectCompaction(records) {
	return projectMethodResponses(records, new Set(["thread/compact/start"]));
}

/** Error-matrix parity pins request pairing and error codes/categories, not server-specific parser text. */
export function projectErrors(records) {
	const requestMethods = new Set(["model/list", "thread/search"]);
	const requested = new Set();
	const projected = [];
	for (const record of records) {
		const frame = record.frame;
		if (record.direction === "client->server" && isRequest(frame) && requestMethods.has(frame.method)) {
			requested.add(key(frame.id));
			projected.push(project(record, { id: frame.id, method: frame.method }));
			continue;
		}
		if (record.direction === "server->client" && isResponse(frame) && requested.has(key(frame.id))) {
			const error = isObject(frame.error) ? frame.error : undefined;
			projected.push(project(record, error === undefined ? { id: frame.id, result: {} } : { id: frame.id, error: { code: error.code } }));
		}
	}
	return resequence(projected);
}

function responseStatus(frame) {
	if (isObject(frame.error)) return { error: { code: frame.error.code, message: frame.error.message } };
	if (!Object.hasOwn(frame, "result")) return {};
	const result = frame.result;
	if (!isObject(result)) return { result };
	if (isObject(result.thread) && isObject(result.thread.status)) return { result: { thread: { status: result.thread.status } } };
	if (typeof result.status === "string") return { result: { status: result.status } };
	if (Array.isArray(result.data)) {
		return {
			result: {
				data: result.data.map((entry) => {
					if (!isObject(entry)) return typeof entry;
					if (isObject(entry.status)) return { status: entry.status };
					if (isObject(entry.thread) && isObject(entry.thread.status)) return { thread: { status: entry.thread.status } };
					return {};
				}),
			},
		};
	}
	return { result: {} };
}

function notificationStatus(frame) {
	const params = isObject(frame.params) ? frame.params : {};
	const result = { method: frame.method };
	if (typeof params.threadId === "string") result.threadId = params.threadId;
	if (isObject(params.status)) result.status = params.status;
	if (isObject(params.turn) && typeof params.turn.status === "string") result.turn = { status: params.turn.status };
	return result;
}

function resequence(records) {
	return records.map((record, index) => ({ ...record, seq: index + 1 }));
}

function project(record, frame) {
	return { ...record, frame };
}

function key(value) {
	return `${typeof value}:${String(value)}`;
}

function isRequest(frame) {
	return isObject(frame) && typeof frame.method === "string" && Object.hasOwn(frame, "id");
}

function isResponse(frame) {
	return isObject(frame) && Object.hasOwn(frame, "id") && typeof frame.method !== "string";
}

function isNotification(frame) {
	return isObject(frame) && typeof frame.method === "string" && !Object.hasOwn(frame, "id");
}

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
