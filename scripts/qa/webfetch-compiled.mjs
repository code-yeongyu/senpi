#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { startFakeModelServer } from "../../.agents/skills/senpi-qa/scripts/lib/fake-model-server.mjs";
import { writeMockModelsJson } from "../../.agents/skills/senpi-qa/scripts/lib/mock-loop-support.mjs";

const [binaryArgument, evidenceArgument] = process.argv.slice(2);
assert.ok(binaryArgument && evidenceArgument, "usage: bun scripts/qa/webfetch-compiled.mjs <relocated binary> <evidence.json>");
const binary = resolve(binaryArgument);
const evidence = resolve(evidenceArgument);
const fixtureDirectory = new URL("../../packages/coding-agent/test/fixtures/webfetch/", import.meta.url);
const html = readFileSync(new URL("10-base-redirect.html", fixtureDirectory), "utf8");
const scratch = mkdtempSync(join(tmpdir(), "senpi-webfetch-cli-"));
const requests = [];
// Same redirect routing as todo 1's audit fixture server; serve this task's frozen golden input.
const fixtureServer = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 15,
	fetch(request) {
		const path = new URL(request.url).pathname;
		requests.push(path);
		switch (path) {
			case "/fixtures/base/start": return new Response(null, { status: 302, headers: { location: "/fixtures/base/final" } });
			case "/fixtures/base/final": return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
			default: return new Response("unknown fixture", { status: 404 });
		}
	},
});
const url = `http://127.0.0.1:${fixtureServer.port}/fixtures/base/start`;
const model = await startFakeModelServer({ turns: [
	{ toolCalls: [{ name: "webfetch", args: { url, format: "markdown" } }] },
	{ text: "webfetch-complete" },
] });
const command = [`./${basename(binary)}`, "-p", "--mode", "json", "--tools", "webfetch",
	"--provider", "mock", "--model", "mock-model", "--no-session", "--no-context-files", "--no-extensions",
	`fetch ${url} as markdown`];
const resultSchema = z.object({
	type: z.literal("tool_execution_end"), toolName: z.literal("webfetch"), isError: z.literal(false),
	result: z.object({
		content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
		details: z.object({ converted: z.literal(true), status: z.literal(200), finalUrl: z.string(), outputTruncated: z.literal(false) }),
	}),
});
let receipt;
try {
	// Given: relocated compiled binary with only a local deterministic model and fixture endpoint.
	const agent = join(scratch, "agent");
	mkdirSync(agent);
	writeMockModelsJson(agent, model, "openai-completions");
	// When: the real print-mode agent invokes the builtin tool and consumes its result.
	const child = Bun.spawn(command, { cwd: dirname(binary), env: {
		PATH: process.env.PATH ?? "", HOME: scratch, TMPDIR: scratch,
		SENPI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_WEBFETCH: "1",
	}, stdout: "pipe", stderr: "pipe", timeout: 90_000 });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
	]);
	assert.equal(exitCode, 0, stderr);
	const events = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const results = events.map((event) => resultSchema.safeParse(event)).filter((result) => result.success).map((result) => result.data);
	assert.equal(results.length, 1, `Expected one successful webfetch result; stderr=${stderr}; stdout=${stdout}`);
	const result = results[0].result;
	const finalUrl = new URL("/fixtures/base/final", url).href;
	const base = new URL("../assets/", finalUrl).href;
	const golden = readFileSync(new URL("10-base-redirect.md.golden", fixtureDirectory), "utf8").replace(/\n$/, "")
		.replace(/\]\((\.\.\/guide|images\/example\.png|#section)\)/g, (_match, value) => `](${new URL(value, base).href})`);
	// Then: exact golden plus allowed URL absolutization, real redirect sequence and typed tool status.
	assert.equal(result.content.map((part) => part.text).join(""), golden);
	assert.equal(result.details.finalUrl, finalUrl);
	assert.deepEqual(requests, ["/fixtures/base/start", "/fixtures/base/final"]);
	assert.doesNotMatch(stderr, /Cannot find module/);
	receipt = { command, machine: process.env.BUNSHIN_ALIAS ?? process.platform, versions: { bun: Bun.version, node: process.version },
		exitCode, timestamp: new Date().toISOString(), converted: true, golden: "10-base-redirect.md.golden", goldenMatches: true,
		requests, result, stderr, modelRequests: model.requests.length };
} finally {
	await model.stop();
	await fixtureServer.stop(true);
	rmSync(scratch, { recursive: true, force: true });
}
mkdirSync(dirname(evidence), { recursive: true });
writeFileSync(evidence, `${JSON.stringify({ ...receipt, cleanup: "fixture and model servers closed; isolated HOME and agent directory removed" }, null, 2)}\n`);
console.log(JSON.stringify({ converted: true, goldenMatches: true, modelRequests: model.requests.length, cleanup: "servers and sandbox removed" }));
