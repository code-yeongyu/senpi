import { readFileSync } from "node:fs";
const LIB = "/private/tmp/fix-142-codemode/.agents/skills/senpi-qa/scripts/lib";
const { makeSandbox, runCli, guardRealAuth, installCleanupHooks, readJsonl } = await import(`${LIB}/common.mjs`);
const { startFakeModelServer } = await import(`${LIB}/fake-model-server.mjs`);
const { writeMockModelsJson, hermeticEnv } = await import(`${LIB}/mock-loop-support.mjs`);

const LOG = "/tmp/eval-fresh-qa/tool-calls.jsonl";
const EXT = "/tmp/eval-fresh-qa/demo-ext.mjs";

installCleanupHooks();
const guard = guardRealAuth();
const results = [];
function ok(name, pass, detail) {
	results.push({ name, pass, detail });
	console.log(`[${pass ? "PASS" : "FAIL"}] ${name} :: ${detail}`);
}

async function scenario({ label, language, code, turns2Text = "done" }) {
	const box = makeSandbox(`eval-fresh-${label}`);
	const server = await startFakeModelServer({
		turns: [
			{ toolCalls: [{ name: "eval", args: { language, code } }] },
			{ text: turns2Text },
		],
	});
	writeMockModelsJson(box.agentDir, server, "openai-completions");
	const args = [
		"--provider", "mock", "--model", "mock-model",
		"--no-context-files",
		"-e", EXT,
		"--approve",
		"--print", `Run an ${language} eval cell that calls the demo tool.`,
	];
	const result = await runCli(args, { env: hermeticEnv(box.env), cwd: box.cwd, timeoutMs: 120000 });
	const out = result.stdout + result.stderr;
	return { box, server, result, out };
}

// S1: JS eval calls extension tool via tool.demo_tool bridge; hooks fire; result rewritten.
{
	const { box, server, result, out } = await scenario({
		label: "js",
		language: "js",
		code: "const r = await tool.demo_tool({ q: 'freshqa' }); return r;",
	});
	const log = (() => { try { return readJsonl(readFileSync(LOG, "utf8")); } catch { return []; } })();
	const executed = log.some((e) => e.ev === "execute" && e.q === "freshqa");
	const hookArgs = log.some((e) => e.ev === "tool_call" && e.input && e.input.q === "freshqa");
	// The rewritten tool_result rides the eval cell's return value back to the model in request #2.
	const reqBlob = JSON.stringify(server.requests);
	const rewritten = log.some((e) => e.ev === "tool_result") && reqBlob.includes("demo:freshqa:rewritten");
	ok("S1 JS eval -> extension tool via bridge, tool_call+tool_result hooks fire, rewritten",
		result.code === 0 && executed && hookArgs && rewritten,
		`code=${result.code} executed=${executed} hookArgs=${hookArgs} rewritten=${rewritten} reqs=${server.requests.length}`);
	if (!(executed && rewritten)) process.stderr.write(`\n--- S1 stderr tail ---\n${result.stderr.slice(-1500)}\n`);
	await server.stop(); box.cleanup();
}

// S2: Python eval cell executes real code through the live loop + bridge.
{
	const { box, server, result, out } = await scenario({
		label: "py",
		language: "py",
		code: "r = tool.demo_tool(q='pyfresh')\nprint('PYVAL:' + str(r))\nr",
	});
	const reqBlob2 = JSON.stringify(server.requests);
	const executedPy = reqBlob2.includes("demo:pyfresh") || reqBlob2.includes("PYVAL:");
	ok("S2 Python eval cell executes real code + tool bridge dispatch",
		result.code === 0 && server.requests.length >= 2 && executedPy,
		`code=${result.code} reqs=${server.requests.length} sawResult=${executedPy}`);
	if (!executedPy) process.stderr.write(`\n--- S2 stdout tail ---\n${out.slice(-1500)}\n`);
	await server.stop(); box.cleanup();
}

guard.assertUnchanged();
const passed = results.filter((r) => r.pass).length;
console.log(`\nfresh-eval-qa: ${passed}/${results.length} passed  (real auth: ${guard.path} unchanged)`);
process.exit(passed === results.length ? 0 : 1);
