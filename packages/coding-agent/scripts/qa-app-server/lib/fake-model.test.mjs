import assert from "node:assert/strict";
import { test } from "vitest";
import { startFakeModelServer } from "./fake-model.mjs";

const requestBody = { model: "mock-model", messages: [{ role: "user", content: "fixture request" }] };

test("fake model defaults completion finish_reason to stop", async () => {
	const fake = await startFakeModelServer([{ text: "complete" }]);
	try {
		const response = await requestCompletion(fake);
		assert.equal(response.status, 200);
		assert.match(await response.text(), /"finish_reason":"stop"/);
	} finally {
		await fake.stop();
	}
});

test("fake model emits a requested completion finish_reason", async () => {
	const fake = await startFakeModelServer([{ text: "cut off", finishReason: "length" }]);
	try {
		const response = await requestCompletion(fake);
		assert.equal(response.status, 200);
		assert.match(await response.text(), /"finish_reason":"length"/);
	} finally {
		await fake.stop();
	}
});

test("fake model emits a requested terminal provider error", async () => {
	const fake = await startFakeModelServer([{ error: { status: 503, message: "fixture terminal error" } }]);
	try {
		const response = await requestCompletion(fake);
		assert.equal(response.status, 503);
		assert.deepEqual(await response.json(), { error: { message: "fixture terminal error" } });
	} finally {
		await fake.stop();
	}
});

test("waitForRequest resolves the exact post-mark request from its record notification", async () => {
	const fake = await startFakeModelServer([{ text: "first" }, { text: "second" }]);
	try {
		await requestCompletion(fake, "before mark");
		const mark = fake.requests.length;
		const matchingRequest = fake.waitForRequest(
			(request) => request.url === "/v1/chat/completions" && request.messages?.[0]?.content === "after mark",
			mark,
			1_000,
		);
		const response = await requestCompletion(fake, "after mark");
		assert.equal(response.status, 200);
		assert.equal((await matchingRequest).messages[0].content, "after mark");
		assert.equal(await fake.waitForRequest((request) => request.messages?.[0]?.content === "after mark", mark, 1_000), fake.requests[mark]);
	} finally {
		await fake.stop();
	}
});

test("waitForHold resolves only after the exact post-mark request is held", async () => {
	const fake = await startFakeModelServer([{ hold: true }]);
	try {
		const hold = fake.waitForHold(
			(record) => record.request.messages?.[0]?.content === "hold after mark",
			fake.holds.length,
			1_000,
		);
		const response = requestCompletion(fake, "hold after mark");
		const record = await hold;
		assert.equal(record.request.messages[0].content, "hold after mark");
		fake.releaseHolds();
		assert.equal((await response).status, 200);
	} finally {
		await fake.stop();
	}
});

test("fake model accounts for successful and terminal-error requests", async () => {
	const fake = await startFakeModelServer([{ text: "complete" }, { error: { status: 500, message: "failed" } }]);
	try {
		await requestCompletion(fake, "first");
		await requestCompletion(fake, "second");
		assert.deepEqual(fake.requests, [
			{
				method: "POST",
				url: "/v1/chat/completions",
				authorization: null,
				model: "mock-model",
				messages: [{ role: "user", content: "first" }],
			},
			{
				method: "POST",
				url: "/v1/chat/completions",
				authorization: null,
				model: "mock-model",
				messages: [{ role: "user", content: "second" }],
			},
		]);
	} finally {
		await fake.stop();
	}
});

test("concurrent fake models allocate unique endpoints and retain exact request attribution", async () => {
	const requestCount = 12;
	const fakes = await Promise.all(Array.from({ length: requestCount }, () => startFakeModelServer([{ text: "complete" }])));
	try {
		const requestMessages = Array.from({ length: requestCount }, (_, index) => `concurrent fixture ${index}`);
		const received = fakes.map((fake, index) =>
			fake.waitForRequest(
				(request) => request.url === "/v1/chat/completions" && request.messages?.[0]?.content === requestMessages[index],
				fake.requests.length,
				1_000,
			),
		);
		const responses = await Promise.all(fakes.map((fake, index) => requestCompletion(fake, requestMessages[index])));
		await Promise.all(responses.map((response) => response.text()));
		const records = await Promise.all(received);

		assert.equal(new Set(fakes.map((fake) => fake.url)).size, requestCount);
		assert.deepEqual(records.map((record) => record.messages[0].content), requestMessages);
		assert.deepEqual(fakes.map((fake) => fake.requests.length), Array(requestCount).fill(1));
	} finally {
		await Promise.all(fakes.map((fake) => fake.stop()));
	}
});

function requestCompletion(fake, content = requestBody.messages[0].content) {
	return fetch(`${fake.url}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ ...requestBody, messages: [{ role: "user", content }] }),
	});
}
