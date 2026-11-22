import assert from "node:assert/strict";
import { onTestFinished, test } from "vitest";
import { ctx, fake, model, open } from "./helpers.ts";

// senpi#4282: a provider error the stream throws never passes the provider stream boundary, so the generation
// classifies and redacts it itself before anything records it.
const secret = ["zzfixture", "4282", "thrownQ"].join("");

test("a thrown model_not_found is a configuration error: no retry, and no sink records the raw body", async () => {
	const base = fake({ respond: () => ({ text: "unused" }) });
	let calls = 0;
	const models = {
		...base,
		stream: () => {
			calls++;
			const failure = new Error(`404 {"code":"model_not_found"} x-api-key: ${secret}`);
			return { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(failure) }) };
		},
	};
	const env = await open({
		models,
		root: { rewindable: { model }, sticky: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } },
	});
	onTestFinished(() => env.close());

	const failed = await (await env.root.send({ content: "first" }, ctx)).wait(ctx);

	assert.equal(failed.reason, "failed");
	assert.equal(calls, 1);
	const recorded = JSON.stringify([await env.entries(), await env.tasks()]);
	assert.equal(recorded.includes(secret), false);
	assert.match(recorded, /\[REDACTED\]/);
});
