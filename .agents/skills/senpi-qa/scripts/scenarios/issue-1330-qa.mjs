#!/usr/bin/env node
/** Real CLI QA for #1330's conservative numeric paragraph-loop detector. */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createChecks, evidenceDir, guardRealAuth, installCleanupHooks, makeSandbox, runCli } from "../lib/common.mjs";
import { startFakeModelServer } from "../lib/fake-model-server.mjs";
import { API_PRESETS, hermeticEnv, writeMockModelsJson } from "../lib/mock-loop-support.mjs";

const API_NAME = "openai-completions";
const FINAL_MARKER = "SENPI-QA-1330-NUMERIC-RECOVERY";
const TOOL_MARKER = "SENPI-QA-1330-TOOL-PROGRESS-FINAL";
const NORMAL_MARKER = "SENPI-QA-1330-NORMAL-FINAL";
const CODE_MARKER = "SENPI-QA-1330-CODE-FINAL";

function singleDigitParagraph(step) {
	return `I am carefully describing the exact same implementation plan for this task, but now writing step ${step} with no substantive progress at all.`;
}

function codeParagraph(value) {
	return `const retryLimit = ${value}; const detail = "This code paragraph stays long enough to be eligible while its literal is meaningful program data.";`;
}

function readFirstPersistedAssistant(box) {
	const files = readdirSync(box.sessionDir, { recursive: true, encoding: "utf8" })
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => join(box.sessionDir, name));
	for (const file of files) {
		for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
			if (!line.trim()) continue;
			const entry = JSON.parse(line);
			if (entry.type === "message" && entry.message?.role === "assistant") return entry.message;
		}
	}
	return undefined;
}

function assistantText(message) {
	return Array.isArray(message?.content)
		? message.content
				.filter((block) => block?.type === "text" && typeof block.text === "string")
				.map((block) => block.text)
				.join("")
		: "";
}

function writeEventExtension(box) {
	const eventPath = join(box.dir, "agent-events.jsonl");
	const extensionPath = join(box.dir, "issue-1330-events.mjs");
	writeFileSync(
		extensionPath,
		`import { appendFileSync } from "node:fs";\nconst path = ${JSON.stringify(eventPath)};\nconst record = (event) => appendFileSync(path, JSON.stringify(event) + "\\n");\nexport default function(pi) { pi.on("agent_end", (event) => record({ type: "agent_end", aborted: event.aborted, abortSource: event.abortSource })); pi.on("message_update", (event) => record({ type: event.assistantMessageEvent.type })); }\n`,
	);
	return { eventPath, extensionPath };
}

function readEvents(path) {
	return existsSync(path)
		? readFileSync(path, "utf8")
				.split(/\r?\n/)
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: [];
}

function requestText(message) {
	if (typeof message?.content === "string") return message.content;
	if (!Array.isArray(message?.content)) return "";
	return message.content
		.map((part) => (typeof part?.text === "string" ? part.text : typeof part?.content === "string" ? part.content : ""))
		.join("\n");
}

function sanitizeRequests(requests) {
	return requests.map((request) => ({
		method: request.method,
		url: request.url,
		model: request.model,
		stream: request.stream,
		authorization: request.authorization ? "<mock-redacted>" : null,
		apiKeyHeader: request.apiKeyHeader ? "<mock-redacted>" : null,
		messages: (request.body?.messages ?? []).map((message) => {
			const text = requestText(message);
			return {
				role: message?.role,
				chars: text.length,
				content: message?.role === "system" ? "<system prompt omitted>" : text.slice(0, 2000),
			};
		}),
		toolNames: (request.tools ?? [])
			.map((tool) => tool?.function?.name ?? tool?.name)
			.filter((name) => typeof name === "string"),
	}));
}

async function runCase(name, turns, extraArgs = []) {
	const box = makeSandbox(`issue-1330-${name}`);
	const server = await startFakeModelServer({ turns });
	const prepared = writeEventExtension(box);
	const preset = API_PRESETS[API_NAME];
	writeMockModelsJson(box.agentDir, server, API_NAME);
	try {
		const result = await runCli(
			[
				"--provider",
				preset.provider,
				"--model",
				preset.modelId,
				"--no-context-files",
				"--no-extensions",
				"--extension",
				prepared.extensionPath,
				"--approve",
				...extraArgs,
				"--print",
				`Run the deterministic ${name} QA case.`,
			],
			{ env: hermeticEnv(box.env), cwd: box.cwd, timeoutMs: 120000 },
		);
		return {
			name,
			result,
			requests: sanitizeRequests(server.requests),
			events: readEvents(prepared.eventPath),
			persisted: readFirstPersistedAssistant(box),
			cleanup: async () => {
				await server.stop();
				box.cleanup();
				return { serverStopped: true, sandboxRemoved: !existsSync(box.dir) };
			},
		};
	} catch (error) {
		await server.stop();
		box.cleanup();
		throw error;
	}
}

function parseArgs(argv) {
	let evidenceSlug;
	let selfTest = false;
	for (let index = 0; index < argv.length; index++) {
		if (argv[index] === "--self-test") selfTest = true;
		else if (argv[index] === "--evidence") evidenceSlug = argv[++index];
		else throw new Error(`unknown argument: ${argv[index]}`);
	}
	if (evidenceSlug !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(evidenceSlug)) {
		throw new Error("--evidence requires a safe single path segment");
	}
	return { evidenceSlug, selfTest };
}

async function main() {
	const { evidenceSlug, selfTest } = parseArgs(process.argv.slice(2));
	installCleanupHooks();
	const guard = guardRealAuth();
	const checks = createChecks("issue-1330-qa");
	const reports = [];
	const paragraphs = [singleDigitParagraph(3), singleDigitParagraph(4), singleDigitParagraph(5)];

	const numeric = await runCase("original-single-digit-loop", [{ text: `${paragraphs.join("\n\n")}\n\n`, chunks: 30 }, { text: FINAL_MARKER }]);
	try {
		const persistedText = assistantText(numeric.persisted);
		const recoveryRequest = JSON.stringify(numeric.requests[1] ?? {});
		checks.ok("numeric loop: real CLI exits after exactly one recovery", numeric.result.code === 0 && !numeric.result.timedOut && numeric.requests.length === 2, `code=${numeric.result.code} requests=${numeric.requests.length}`);
		checks.ok("numeric loop: system abort is observable before recovery", numeric.events.filter((event) => event.type === "agent_end").map((event) => event.abortSource).join(",") === "system,", `events=${JSON.stringify(numeric.events)}`);
		checks.ok("numeric loop: persisted replay is truncated at the first repeat", persistedText.includes(paragraphs[0]) && !persistedText.includes(paragraphs[1]) && persistedText.includes("[output interrupted by stream rule]"), `chars=${persistedText.length}`);
		checks.ok("numeric loop: recovery request carries one collapse nudge", recoveryRequest.includes("collapse-repetition"), `nudge=${recoveryRequest.includes("collapse-repetition")}`);
		checks.ok("numeric loop: final recovery marker reaches the actual CLI output", `${numeric.result.stdout}\n${numeric.result.stderr}`.includes(FINAL_MARKER), `marker=${FINAL_MARKER}`);
		reports.push({ name: numeric.name, result: numeric.result, requests: numeric.requests, events: numeric.events });
	} finally {
		const cleanup = await numeric.cleanup();
		reports.push({ name: `${numeric.name}-cleanup`, cleanup });
	}

	const tool = await runCase(
		"tool-progress-collapse-isolation",
		[
			{ text: `${paragraphs[0]}\n\n`, toolCalls: [{ name: "bash", args: { command: "printf first-progress" } }] },
			{ text: `${paragraphs[1]}\n\n`, toolCalls: [{ name: "bash", args: { command: "printf second-progress" } }] },
			{ text: `${paragraphs[2]}\n\n${TOOL_MARKER}` },
		],
		["--ttsr-rules-disabled", "repetitive-turns"],
	);
	try {
		checks.ok("tool progress (collapse isolation): three same-track occurrences complete without a collapse remediation", tool.result.code === 0 && !tool.result.timedOut && tool.requests.length === 3 && tool.events.filter((event) => event.type === "agent_end").every((event) => event.abortSource !== "system"), `scope=collapse-only; repetitive-turns disabled; code=${tool.result.code} requests=${tool.requests.length} events=${JSON.stringify(tool.events)}`);
		checks.ok("tool progress (collapse isolation): two tool lifecycles precede the third occurrence", tool.events.filter((event) => event.type === "toolcall_end").length === 2 && `${tool.result.stdout}\n${tool.result.stderr}`.includes(paragraphs[2]), `toolEnds=${tool.events.filter((event) => event.type === "toolcall_end").length}`);
		checks.ok("tool progress (collapse isolation): final marker reaches the actual CLI output", `${tool.result.stdout}\n${tool.result.stderr}`.includes(TOOL_MARKER), `marker=${TOOL_MARKER}`);
		reports.push({ name: tool.name, result: tool.result, requests: tool.requests, events: tool.events });
	} finally {
		reports.push({ name: `${tool.name}-cleanup`, cleanup: await tool.cleanup() });
	}

	const normal = await runCase("normal-progress-full-guard", [
		{ text: "I inspected the implementation and found the first distinct source location.", toolCalls: [{ name: "bash", args: { command: "printf normal-first" } }] },
		{ text: "I changed the isolated detector condition and documented a separate safety rationale.", toolCalls: [{ name: "bash", args: { command: "printf normal-second" } }] },
		{ text: `I verified the regression suite against a distinct final assertion: ${NORMAL_MARKER}.` },
	]);
	const code = await runCase("code-control", [{ text: `${[3, 4, 5].map(codeParagraph).join("\n\n")}\n\n\`\`\`ts\n${[3, 4, 5].map(codeParagraph).join("\n\n")}\n\`\`\`\n\n\`\`\`\`markdown\n\`\`\`text\n\n${paragraphs.join("\n\n")}\n\n\`\`\`\n\`\`\`\`\n\n${CODE_MARKER}` }]);
	try {
		checks.ok("normal progress (full guard): three distinct tool-backed updates avoid every remediation", normal.result.code === 0 && !normal.result.timedOut && normal.requests.length === 3 && normal.events.filter((event) => event.type === "agent_end").every((event) => event.abortSource !== "system"), `scope=all protections; code=${normal.result.code} requests=${normal.requests.length} events=${JSON.stringify(normal.events)}`);
		checks.ok("code control: unfenced, fenced, and nested-fence examples avoid a remediation", code.result.code === 0 && !code.result.timedOut && code.requests.length === 1 && code.events.filter((event) => event.type === "agent_end").every((event) => event.abortSource !== "system"), `code=${code.result.code} requests=${code.requests.length} events=${JSON.stringify(code.events)}`);
		checks.ok("normal prose: marker reaches actual CLI output", `${normal.result.stdout}\n${normal.result.stderr}`.includes(NORMAL_MARKER), `marker=${NORMAL_MARKER}`);
		checks.ok("code control: marker reaches actual CLI output", `${code.result.stdout}\n${code.result.stderr}`.includes(CODE_MARKER), `marker=${CODE_MARKER}`);
		reports.push(
			{ name: normal.name, result: normal.result, requests: normal.requests, events: normal.events },
			{ name: code.name, result: code.result, requests: code.requests, events: code.events },
		);
	} finally {
		reports.push(
			{ name: `${normal.name}-cleanup`, cleanup: await normal.cleanup() },
			{ name: `${code.name}-cleanup`, cleanup: await code.cleanup() },
		);
	}

	guard.assertUnchanged();
	checks.ok("credential guard: real auth is unchanged", true, "guardRealAuth passed");
	if (evidenceSlug !== undefined) {
		const dir = evidenceDir(evidenceSlug);
		writeFileSync(join(dir, "issue-1330-qa.json"), `${JSON.stringify({ command: process.argv.slice(0, 2).join(" "), selfTest, reports }, null, 2)}\n`);
		const rawOutput = reports
			.filter((report) => report.result !== undefined)
			.map((report) => `--- ${report.name} stdout ---\n${report.result.stdout}\n--- ${report.name} stderr ---\n${report.result.stderr}`)
			.join("\n");
		writeFileSync(join(dir, "issue-1330-qa.raw.log"), `${rawOutput}\n`);
		process.stderr.write(`evidence: ${dir}\n`);
	}
	process.exit(checks.finish() ? 0 : 1);
}

await main();
