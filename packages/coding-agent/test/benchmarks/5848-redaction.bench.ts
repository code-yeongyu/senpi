import { createRedactor, REDACTED } from "../../src/core/egress/redact.ts";

// senpi#5848 / custody design 3.4 wall-time gate: redacting a 64 KB message against one 4 KB sealed token
// (every whole-value form plus its 8-grams) stays under 5 ms. Run with plain node:
//   nice -n 10 node packages/coding-agent/test/benchmarks/5848-redaction.bench.ts
// Exit 0: the min of 30 runs is within budget and the token was removed; 1 otherwise.

const TOKEN_BYTES = 4 * 1024;
const MESSAGE_BYTES = 64 * 1024;
const RUNS = 30;
const WARMUP = 5;
const BUDGET_MS = 5;

function deterministicText(length: number, seed: number): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
	let state = seed;
	let out = "";
	for (let i = 0; i < length; i++) {
		state = (Math.imul(state, 1103515245) + 12345) >>> 0;
		out += alphabet[state % alphabet.length];
	}
	return out;
}

const token = deterministicText(TOKEN_BYTES, 7);
const filler = deterministicText(MESSAGE_BYTES - 2 * TOKEN_BYTES - 64, 11).replace(/(.{80})/gu, "$1 ");
const message = `start ${token} middle ${filler.slice(0, MESSAGE_BYTES - 2 * TOKEN_BYTES - 64)} end ${token}`;

const buildStart = performance.now();
const redactor = createRedactor({ secrets: [token], publicPrefixes: [] });
const buildMs = performance.now() - buildStart;

let output = "";
for (let i = 0; i < WARMUP; i++) output = redactor.redact(message);
const times: number[] = [];
for (let i = 0; i < RUNS; i++) {
	const start = performance.now();
	output = redactor.redact(message);
	times.push(performance.now() - start);
}
times.sort((a, b) => a - b);
const min = times[0];
const median = times[Math.floor(times.length / 2)];
const removed = !output.includes(token.slice(100, 108)) && output.includes(REDACTED);

console.log(
	JSON.stringify({
		messageBytes: message.length,
		tokenBytes: token.length,
		buildMs: Number(buildMs.toFixed(2)),
		minMs: Number(min.toFixed(3)),
		medianMs: Number(median.toFixed(3)),
		budgetMs: BUDGET_MS,
		removed,
	}),
);
process.exit(removed && min <= BUDGET_MS ? 0 : 1);
