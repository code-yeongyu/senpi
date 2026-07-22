import { connectDriver } from "../../../../scripts/qa-app-server/differential/driver.mjs";

const CLIENT_INFO = Object.freeze({
	name: "senpi-differential-qa",
	title: "Differential QA",
	version: "1.0.0",
});

export class ScenarioError extends Error {
	name = "ScenarioError";
}

export function initializeBytes(experimentalApi = true) {
	return JSON.stringify({
		id: "initialize",
		method: "initialize",
		params: { clientInfo: CLIENT_INFO, capabilities: { experimentalApi } },
	});
}

export async function runAgainstEndpoints(endpoints, run) {
	const results = [];
	for (const endpoint of endpoints) {
		const driver = await connectDriver(endpoint);
		try {
			await run(driver, endpoint);
			results.push({ target: endpoint.target, transcript: driver.transcript });
		} finally {
			await driver.close();
		}
	}
	return results;
}

export async function initialize(driver, { experimentalApi = true } = {}) {
	const response = await driver.requestRaw(initializeBytes(experimentalApi), "initialize");
	assertResult(response, "initialize");
	await driver.sendRaw(JSON.stringify({ method: "initialized" }));
	return response.result;
}

export async function request(driver, id, method, params = {}) {
	return driver.requestRaw(JSON.stringify({ id, method, params }), id);
}

export async function requestResult(driver, id, method, params = {}) {
	const response = await request(driver, id, method, params);
	assertResult(response, `${driver.target} ${method}`);
	return response.result;
}

export async function requestError(driver, id, method, params = {}) {
	const response = await request(driver, id, method, params);
	if (!isObject(response) || !isObject(response.error) || typeof response.error.code !== "number") {
		throw new ScenarioError(`${method} did not return a JSON-RPC error.`);
	}
	return response.error;
}

export async function startThread(driver, cwd, id = "thread-start", options = {}) {
	const mark = driver.mark();
	const started = driver.waitForInbound(
		(frame) => isNotification(frame, "thread/started"),
		mark,
	);
	const result = await requestResult(driver, id, "thread/start", {
		cwd,
		model: "mock-model",
		modelProvider: "mock_provider",
		approvalPolicy: options.approvalPolicy ?? "never",
		...(options.historyMode === undefined ? {} : { historyMode: options.historyMode }),
	});
	const threadId = stringField(objectField(result, "thread"), "id");
	await started;
	return threadId;
}

export async function startTurn(driver, id, threadId, text) {
	const mark = driver.mark();
	const started = driver.waitForInbound(
		(frame) => isNotification(frame, "turn/started") && notificationThreadId(frame) === threadId,
		mark,
	);
	const result = await requestResult(driver, id, "turn/start", {
		threadId,
		input: [{ type: "text", text }],
	});
	const turnId = stringField(result, "turn", "id");
	await started;
	return { turnId, mark };
}

export function waitForNotification(driver, method, from, threadId) {
	return driver.waitForInbound(
		(frame) => isNotification(frame, method) && (threadId === undefined || notificationThreadId(frame) === threadId),
		from,
		120_000,
	);
}

export function assertResult(frame, method) {
	if (!isObject(frame) || !Object.hasOwn(frame, "result")) {
		throw new ScenarioError(`${method} did not return a JSON-RPC result: ${JSON.stringify(frame)}`);
	}
}

export function assertErrorCode(error, code, method) {
	if (error.code !== code) {
		throw new ScenarioError(`${method} returned error code ${String(error.code)}, expected ${code}.`);
	}
}

export function objectField(value, ...keys) {
	let current = value;
	for (const key of keys) {
		if (!isObject(current) || !isObject(current[key])) {
			throw new ScenarioError(`Expected object field ${key}.`);
		}
		current = current[key];
	}
	return current;
}

export function stringField(value, ...keys) {
	let current = value;
	for (const [index, key] of keys.entries()) {
		if (!isObject(current) || !Object.hasOwn(current, key)) {
			throw new ScenarioError(`Expected field ${key}.`);
		}
		current = current[key];
		if (index === keys.length - 1 && (typeof current !== "string" || current.length === 0)) {
			throw new ScenarioError(`Expected nonempty string field ${key}.`);
		}
	}
	return current;
}

export function arrayField(value, key) {
	if (!isObject(value) || !Array.isArray(value[key])) throw new ScenarioError(`Expected array field ${key}.`);
	return value[key];
}

export function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isNotification(frame, method) {
	return isObject(frame) && frame.method === method && !Object.hasOwn(frame, "id");
}

function notificationThreadId(frame) {
	return isObject(frame) && isObject(frame.params) && typeof frame.params.threadId === "string" ? frame.params.threadId : undefined;
}
