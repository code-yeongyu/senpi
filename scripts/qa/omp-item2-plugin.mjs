import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { guardRealAuth, makeSandbox } from "../../.agents/skills/senpi-qa/scripts/lib/common.mjs";

function bounded(promise, label) {
	let timer;
	return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 60_000); })]).finally(() => clearTimeout(timer));
}
function extractAggregate(value) {
	if (value == null || typeof value !== "object") return;
	if (value.customType === "senpi-task.workpool-aggregate" && value.details && typeof value.details.pool_id === "string" && Array.isArray(value.details.results)) return value.details;
	if (Array.isArray(value.details)) {
		for (const entry of value.details) {
			const found = extractAggregate(entry);
			if (found) return found;
		}
	}
	if (value.message) return extractAggregate(value.message);
}
function send(response, step) {
	response.writeHead(200, { "content-type": "text/event-stream" });
	const delta = typeof step === "string" ? { content: step } : { tool_calls: [{ index: 0, id: `fixture-${crypto.randomUUID()}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.args) } }] };
	for (const [part, finish] of [[{ role: "assistant" }, null], [delta, null], [{}, typeof step === "string" ? "stop" : "tool_calls"]]) {
		response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: part, finish_reason: finish }] })}\n\n`);
	}
	response.end("data: [DONE]\n\n");
}
const spec = { category: "fixture", prompt: "Return assigned key a through workpool yield" };
const items = [{ key: "a", input: { n: 1 } }];
const expectedResults = [{ key: "a", data: { answer: 42 } }];
const createCode = `
const spec = ${JSON.stringify(spec)};
const typed = await agent('Return S2_TASK_DONE', {agent:'explore', model:'fixture/fixture', handle:true});
const pool = await workpool(spec, 's2-parity', {mode:'fresh'});
const direct = await tool.workpool({op:'create', agent:spec, name:'s2-parity', mode:'fresh'});
const pushed = await pool.push(${JSON.stringify(items)});
const duplicate = await tool.workpool({op:'push', pool_id:pool.pool_id, items:${JSON.stringify(items)}});
await write('s2-pool-id.json', JSON.stringify({pool_id:pool.pool_id}));
display({phase:'create', typed, pool_id:pool.pool_id, direct:direct.details.pool_id, pushed:pushed.details, duplicate:duplicate.details});`;
const resetCode = `
const saved = JSON.parse(await read('s2-pool-id.json'));
const inspected = await tool.workpool({op:'inspect', pool_id:saved.pool_id});
const restored = await workpool(${JSON.stringify(spec)}, 's2-parity', {mode:'fresh'});
const closed = await restored.close();
display({phase:'reset', pool_id:restored.pool_id, inspected:inspected.details, closed:closed.details});`;

export async function runInstalledPlugin(outDir) {
	const checkout = process.env.OMO_WORKPOOL_CHECKOUT;
	const expectedSha = process.env.OMO_WORKPOOL_SHA;
	assert(checkout && expectedSha && /^[0-9a-f]{40}$/.test(expectedSha), "Set OMO_WORKPOOL_CHECKOUT and exact OMO_WORKPOOL_SHA");
	const producerSha = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	assert.equal(producerSha, expectedSha);
	const plugin = join(resolve(checkout), "packages/omo-senpi/plugin");
	const bundleSha256 = createHash("sha256").update(await readFile(join(plugin, "extensions/omo-task.js"))).digest("hex");
	const guard = guardRealAuth();
	const box = makeSandbox("senpi-s2-plugin");
	const calls = [];
	const outputs = [];
	const workerYield = Promise.withResolvers();
	let parentStep = 0;
	let workerStep = 0;
	let foreign = false;
	let fixtureFailure;
	let aggregateMessage;
	const server = createServer((request, response) => {
		const chunks = [];
		request.on("data", chunk => chunks.push(chunk));
		request.on("end", () => {
			void (async () => {
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				const names = (body.tools ?? []).map(tool => tool.function.name);
				const parent = names.includes("task");
				calls.push({ parent, foreign, names });
				if (!parent) {
					if (!names.includes("workpool")) return send(response, "S2_TASK_DONE");
					if (workerStep++ === 0) return send(response, { name: "workpool", args: { op: "yield", results: expectedResults } });
					const last = body.messages.filter(message => message.role === "tool").at(-1);
					workerYield.resolve(JSON.parse(last.content));
					return send(response, "S2_WORKER_DONE");
				}
				if (foreign) {
					if (parentStep++ === 0) return send(response, { name: "eval", args: { language: "js", summary: "Check foreign pool ownership", code: "const saved=JSON.parse(await read('s2-pool-id.json')); display({denial:await tool.workpool({op:'inspect',pool_id:saved.pool_id})});" } });
					return send(response, "S2_FOREIGN_DONE");
				}
				if (parentStep++ === 0) return send(response, { name: "eval", args: { language: "js", summary: "Compare host workpool and sugar", code: createCode } });
				if (parentStep === 2) {
					await bounded(workerYield.promise, "Worker yield was not observed");
					return send(response, { name: "eval", args: { language: "js", summary: "Inspect engine pool after reset", reset: true, code: resetCode } });
				}
				send(response, "S2_PARENT_DONE");
			})().catch(error => {
				fixtureFailure = error;
				response.writeHead(500).end(JSON.stringify({ error: { message: String(error) } }));
			});
		});
	});
	let child;
	async function session(label) {
		child = spawn("node", [resolve(import.meta.dirname, "../../packages/coding-agent/dist/cli.js"), "-p", "--mode", "json", "--provider", "fixture", "--model", "fixture", "--no-context-files", label], { cwd: box.cwd, env: box.env, stdio: ["ignore", "pipe", "pipe"] });
		const exited = once(child, "close");
		let stdout = ""; let stderr = ""; let buffer = "";
		const failed = Promise.withResolvers();
		child.stdout.on("data", chunk => {
			stdout += chunk; buffer += chunk;
			let newline;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line);
					const found = extractAggregate(event);
					if (found && !aggregateMessage) aggregateMessage = found;
					if (event.type === "tool_execution_end" && event.toolName === "eval" && (event.isError || event.result.details?.isError)) failed.reject(new Error(JSON.stringify(event)));
				} catch (error) { failed.reject(error); }
			}
		});
		child.stderr.on("data", chunk => { stderr += chunk; });
		let code;
		try { [code] = await bounded(Promise.race([exited, failed.promise]), "Fixture CLI did not exit"); }
		catch (error) { child.kill("SIGKILL"); await exited; throw error; }
		finally {
			await writeFile(join(outDir, `${label}.stdout.jsonl`), stdout);
			await writeFile(join(outDir, `${label}.stderr.log`), stderr);
			await writeFile(join(outDir, `${label}.calls.json`), JSON.stringify(calls, null, 2));
		}
		assert.equal(code, 0, stderr);
		if (fixtureFailure) throw fixtureFailure;
		const events = stdout.split("\n").filter(Boolean).map(line => JSON.parse(line));
		const results = events.filter(event => event.type === "tool_execution_end" && event.toolName === "eval");
		assert(results.length > 0, "Actual eval tool must execute");
		for (const result of results) {
			assert(!result.isError && !result.result.details?.isError, JSON.stringify(result));
			outputs.push(...(result.result.details?.jsonOutputs ?? []));
		}
		return events;
	}
	try {
		await mkdir(outDir, { recursive: true });
		await mkdir(join(box.cwd, ".omo"), { recursive: true });
		for (const key of Object.keys(box.env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) || key.endsWith("_PACKAGE_DIR")) delete box.env[key];
		Object.assign(box.env, { XDG_CONFIG_HOME: join(box.dir, "xdg"), XDG_DATA_HOME: join(box.dir, "data"), XDG_CACHE_HOME: join(box.dir, "cache"), XDG_STATE_HOME: join(box.dir, "state"), OMO_DISABLE_TELEMETRY: "1", OMO_SENPI_QA: "1" });
		await writeFile(join(box.agentDir, "settings.json"), JSON.stringify({ packages: [plugin], defaultProjectTrust: "ask" }));
		await writeFile(join(box.agentDir, "trust.json"), JSON.stringify({ [box.cwd]: true }));
		await writeFile(join(box.cwd, ".omo/omo.json"), JSON.stringify({ task: { global_concurrency: 1, default_concurrency: 1, default_execution_mode: "in-process" }, categories: { fixture: { model: "fixture/fixture" } }, memory: { enabled: false } }));
		const listening = once(server, "listening"); server.listen(0, "127.0.0.1"); await listening;
		await writeFile(join(box.agentDir, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "fixture", models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
		const events = await session("parent");
		if (!aggregateMessage) {
			for (const event of events) {
				const found = extractAggregate(event);
				if (found) { aggregateMessage = found; break; }
			}
		}
		assert(aggregateMessage, "O2 aggregate delivery was not observed on the parent session");
		const created = outputs.find(value => value.phase === "create");
		const reset = outputs.find(value => value.phase === "reset");
		assert(created && reset, "Actual kernel display results must reach CLI events");
		assert.match(created.typed.id, /^st_[0-9a-f]+$/);
		assert.equal(created.typed.handle, `agent://${created.typed.id}`);
		assert(Number.isInteger(created.typed.run_epoch) && created.typed.run_epoch >= 0);
		assert.equal(created.pool_id, created.direct);
		assert.deepEqual(created.pushed, created.duplicate);
		assert.equal(reset.pool_id, created.pool_id);
		assert.equal(reset.inspected.pool_id, created.pool_id);
		foreign = true; parentStep = 0;
		await session("foreign");
		assert.equal(outputs.at(-1).denial.details.error.code, "scope_denied");
		const yielded = await workerYield.promise;
		assert.notEqual(yielded?.error?.code, "yield_unavailable", "O2 yield_unavailable: keyed reconciliation or aggregate delivery is not enabled");
		assert.equal(aggregateMessage.pool_id, created.pool_id);
		assert.deepEqual(aggregateMessage.results, expectedResults);
		const pool = JSON.parse(await readFile(join(box.cwd, ".omo/senpi-task/workpools", `${created.pool_id}.json`), "utf8"));
		return { producerSha, bundleSha256, paidProviderCalls: 0, calls, outputs, pool, yielded, aggregate: aggregateMessage, aggregateVerified: true, eventCount: events.length };
	} finally {
		if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, "close"); child.kill("SIGKILL"); await exited; }
		server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
		box.cleanup();
		guard.assertUnchanged();
	}
}
