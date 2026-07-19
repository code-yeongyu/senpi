import {
	connectDriver,
	expectWebSocketRejected,
	httpStatus,
} from "../../../../scripts/qa-app-server/differential/driver.mjs";

const INITIALIZE_BYTES = JSON.stringify({
	id: "initialize",
	method: "initialize",
	params: {
		clientInfo: { name: "senpi-differential-qa", title: "Differential QA", version: "1.0.0" },
		capabilities: {
			experimentalApi: false,
			optOutNotificationMethods: ["remoteControl/status/changed"],
		},
	},
});
const INITIALIZED_BYTES = JSON.stringify({ method: "initialized" });
const PRE_INIT_BYTES = JSON.stringify({ id: "pre-init", method: "thread/list", params: {} });
const DOUBLE_INIT_BYTES = JSON.stringify({
	id: "double-init",
	method: "initialize",
	params: {
		clientInfo: { name: "senpi-differential-qa", title: "Differential QA", version: "1.0.0" },
		capabilities: {
			experimentalApi: false,
			optOutNotificationMethods: ["remoteControl/status/changed"],
		},
	},
});
const MALFORMED_BINARY = Uint8Array.from([0xff, 0x00, 0x7f]);

class HandshakeScenarioError extends Error {
	name = "HandshakeScenarioError";
}

export async function runHandshake(endpoints) {
	const results = [];
	for (const endpoint of endpoints) results.push(await runTarget(endpoint));
	return results;
}

async function runTarget(endpoint) {
	const readyStatus = await httpStatus({ port: endpoint.port, path: "/readyz" });
	const healthStatus = await httpStatus({ port: endpoint.port, path: "/healthz" });
	if (readyStatus !== 200 || healthStatus !== 200) {
		throw new HandshakeScenarioError(`${endpoint.target} health endpoints returned ${readyStatus}/${healthStatus}.`);
	}
	await expectWebSocketRejected({ url: endpoint.url });
	await expectWebSocketRejected({ url: endpoint.url, token: "definitely-wrong-capability-token" });

	const driver = await connectDriver(endpoint);
	try {
		const preInit = await driver.requestRaw(PRE_INIT_BYTES, "pre-init");
		assertErrorResponse(preInit, endpoint.target, "pre-init");
		const malformedStart = driver.mark();
		await driver.sendBinary(MALFORMED_BINARY);
		const initialized = await driver.requestRaw(INITIALIZE_BYTES, "initialize");
		assertResultResponse(initialized, endpoint.target, "initialize");
		await driver.sendRaw(INITIALIZED_BYTES);
		const doubleInit = await driver.requestRaw(DOUBLE_INIT_BYTES, "double-init");
		assertErrorResponse(doubleInit, endpoint.target, "double-init");
		const unexpectedMalformedResponse = driver.transcript.slice(malformedStart).some(
			(record) =>
				record.direction === "server->client" &&
				!isResponse(record.frame, "initialize") &&
				!isResponse(record.frame, "double-init"),
		);
		if (unexpectedMalformedResponse) {
			throw new HandshakeScenarioError(`${endpoint.target} responded to the malformed binary frame.`);
		}
	} finally {
		await driver.close();
	}
	return {
		target: endpoint.target,
		transcript: driver.transcript,
		checks: { badTokenRejected: true, missingTokenRejected: true, health: true, malformedBinaryIgnored: true },
	};
}

function assertErrorResponse(frame, target, step) {
	if (!isObject(frame) || !isObject(frame.error) || typeof frame.error.code !== "number") {
		throw new HandshakeScenarioError(`${target} ${step} did not return a JSON-RPC error.`);
	}
}

function assertResultResponse(frame, target, step) {
	if (!isObject(frame) || !isObject(frame.result)) {
		throw new HandshakeScenarioError(`${target} ${step} did not return a JSON-RPC result.`);
	}
}

function isResponse(frame, id) {
	return isObject(frame) && frame.id === id;
}

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
