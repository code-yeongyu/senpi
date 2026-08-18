#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	bootHermeticStack,
	SOURCE_ROOT,
} from "./lib/claude-sdk-oauth-fullstack-harness.mjs";
import { safeDetail } from "./lib/output-safety.mjs";

const TURN_TIMEOUT_MS = 180_000;
const marker = "ISSUE6981-HEADLESS-RESTART";
const tsxImport = fileURLToPath(import.meta.resolve("tsx"));
const evidenceArg = process.argv.indexOf("--evidence");
const evidenceSlug = evidenceArg === -1 ? undefined : process.argv[evidenceArg + 1];

function killTree(child) {
	if (child.exitCode !== null) return;
	try {
		if (process.platform === "win32") child.kill("SIGKILL");
		else process.kill(-child.pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
}

function runCli(stack, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			["--import", tsxImport, join(SOURCE_ROOT, "cli.ts"), ...args],
			{
				cwd: stack.box.cwd,
				detached: process.platform !== "win32",
				env: { ...process.env },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const timeout = setTimeout(() => {
			killTree(child);
			reject(new Error(`CLI turn exceeded ${TURN_TIMEOUT_MS}ms`));
		}, TURN_TIMEOUT_MS);
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timeout);
			resolve({ code: code ?? -1, stdout, stderr });
		});
	});
}

function continuityFrom(stdout) {
	const observations = [];
	const visit = (value) => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (!value || typeof value !== "object") return;
		if (value.type === "claude_sdk_oauth_session_continuity" && value.details) {
			observations.push(value.details);
		}
		if (Array.isArray(value.diagnostics)) {
			for (const diagnostic of value.diagnostics) {
				if (diagnostic?.type === "claude_sdk_oauth_session_continuity") {
					observations.push(diagnostic.details);
				}
			}
		}
		for (const nested of Object.values(value)) visit(nested);
	};
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		try {
			visit(JSON.parse(line));
		} catch {}
	}
	return observations.filter(
		(observation, index, all) =>
			index ===
			all.findIndex(
				(candidate) =>
					candidate.kind === observation.kind &&
					candidate.reason === observation.reason &&
					candidate.deltaMessages === observation.deltaMessages,
			),
	);
}

function listFiles(root) {
	const files = [];
	const walk = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) walk(path);
			else files.push(path);
		}
	};
	walk(root);
	return files;
}

const common = (sessionDir) => [
	"-p",
	"--provider",
	"claude-sdk-oauth",
	"--model",
	"claude-haiku-4-5",
	"--thinking",
	"off",
	"--mode",
	"json",
	"--session-dir",
	sessionDir,
	"--no-tools",
	"--no-context-files",
	"--offline",
	"--no-model-fallback",
	"--no-recommended-models",
	"--system-prompt",
	"Reply with the requested marker only.",
];

let stack;
let summary;
try {
	stack = await bootHermeticStack({ sandboxLabel: "issue-6981-headless-restart" });
	const first = await runCli(stack, [...common(stack.box.sessionDir), `Reply exactly ${marker}-1.`]);
	const second = await runCli(stack, [
		...common(stack.box.sessionDir),
		"-c",
		`Reply exactly ${marker}-2.`,
	]);
	const firstContinuity = continuityFrom(first.stdout);
	const secondContinuity = continuityFrom(second.stdout);
	const sessionFiles = listFiles(stack.box.sessionDir);
	const resumed = secondContinuity.some(
		(observation) => observation.kind === "fork" && observation.reason === "registry_miss",
	);
	const flattened = secondContinuity.some(
		(observation) => observation.kind === "flatten" || observation.kind === "bootstrap",
	);
	const passed =
		first.code === 0 &&
		second.code === 0 &&
		sessionFiles.length > 0 &&
		stack.providerRequests.length >= 2 &&
		resumed &&
		!flattened;
	summary = {
		passed,
		first: { code: first.code, continuity: firstContinuity },
		second: { code: second.code, continuity: secondContinuity },
		sessionFileCount: sessionFiles.length,
		providerRequests: stack.providerRequests.length,
		stderr: {
			first: [
				...first.stderr.split("\n").filter(Boolean).slice(0, 5),
				...first.stderr.split("\n").filter(Boolean).slice(-5),
			].map((line) => safeDetail(line)),
			second: [
				...second.stderr.split("\n").filter(Boolean).slice(0, 5),
				...second.stderr.split("\n").filter(Boolean).slice(-5),
			].map((line) => safeDetail(line)),
		},
	};
	if (evidenceSlug) {
		const directory = join(
			process.cwd(),
			"local-ignore",
			"qa-evidence",
			`${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${evidenceSlug}`,
		);
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
		process.stdout.write(`EVIDENCE ${join(directory, "summary.json")}\n`);
	}
	process.stdout.write(`${JSON.stringify(summary)}\n`);
	process.stdout.write(
		passed
			? "VERDICT: PASS claude-sdk-oauth headless restart continuity\n"
			: "VERDICT: FAIL claude-sdk-oauth headless restart continuity\n",
	);
	process.exitCode = passed ? 0 : 1;
} catch (error) {
	process.stderr.write(`PROBE ERROR: ${safeDetail(error instanceof Error ? error.stack : String(error))}\n`);
	process.exitCode = 2;
} finally {
	await stack?.shutdown();
	stack?.authGuard.assertUnchanged();
	stack?.box.cleanup();
}
