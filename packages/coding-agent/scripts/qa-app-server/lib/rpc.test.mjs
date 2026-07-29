import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "vitest";
import { requestAndWaitForMessageEvent, StdioRpcClient } from "./rpc.mjs";

test("request notification wait is subscribed before a delayed post-response notification", async () => {
	const child = {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
	};
	const client = new StdioRpcClient(child, [], "fixture");
	let releaseNotification;
	const notificationReleased = new Promise((resolve) => {
		releaseNotification = resolve;
	});
	let observeResponse;
	const responseObserved = new Promise((resolve) => {
		observeResponse = resolve;
	});

	child.stdin.once("data", (chunk) => {
		const request = JSON.parse(chunk.toString("utf8"));
		queueMicrotask(async () => {
			child.stdout.write(`${JSON.stringify({ id: request.id, result: { thread: { id: "thread-fixture" } } })}\n`);
			observeResponse();
			await notificationReleased;
			child.stdout.write(
				`${JSON.stringify({ method: "thread/started", params: { thread: { id: "thread-fixture" } }, emittedAtMs: 1 })}\n`,
			);
		});
	});

	const exchange = requestAndWaitForMessageEvent(
		client,
		"thread/start",
		{},
		(message) => message.method === "thread/started" && message.params?.thread?.id === "thread-fixture",
		1000,
	);
	await responseObserved;
	assert.throws(() => client.assertServerEnvelopes(), /no server notifications were observed/);
	releaseNotification();

	const { result, message } = await exchange;
	assert.equal(result.thread.id, "thread-fixture");
	assert.equal(message.method, "thread/started");
	assert.doesNotThrow(() => client.assertServerEnvelopes());
	client.close();
});
