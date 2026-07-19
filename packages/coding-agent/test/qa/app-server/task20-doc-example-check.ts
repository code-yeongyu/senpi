import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	type Exchange,
	parseRecord,
	type RpcRequest,
	stringAt,
	validateDocs,
	withNumberId,
} from "./task20-doc-example-lib.ts";

class LineReader {
	private buffer = "";
	private stderr = "";
	private readonly lines: string[] = [];
	private readonly waiters: Array<(line: string) => void> = [];

	constructor(childProcess: ChildProcessWithoutNullStreams) {
		childProcess.stdout.setEncoding("utf8");
		childProcess.stderr.setEncoding("utf8");
		childProcess.stdout.on("data", (chunk: string) => this.pushStdout(chunk));
		childProcess.stderr.on("data", (chunk: string) => {
			this.stderr += chunk;
		});
	}

	nextLine(timeoutMs: number): Promise<string> {
		const line = this.lines.shift();
		if (line !== undefined) return Promise.resolve(line);
		return new Promise((resolveLine, rejectLine) => {
			const timeout = setTimeout(
				() => rejectLine(new Error(`stdout line not observed within ${timeoutMs}ms`)),
				timeoutMs,
			);
			this.waiters.push((value) => {
				clearTimeout(timeout);
				resolveLine(value);
			});
		});
	}

	stderrText(): string {
		return this.stderr;
	}

	private pushStdout(chunk: string): void {
		this.buffer += chunk;
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline === -1) return;
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			const waiter = this.waiters.shift();
			if (waiter) {
				waiter(line);
			} else {
				this.lines.push(line);
			}
		}
	}
}

const codingAgentDir = process.cwd();
const repoRoot = resolve(codingAgentDir, "../..");
const evidencePath = join(repoRoot, ".omo/evidence/task-20-live-examples.txt");
const capabilityManifestPath = join(codingAgentDir, "test/qa/app-server/capability-manifest.json");

type CapabilityManifest = {
	readonly documentation: { readonly methods: readonly string[] };
};

const scratchRoot = await mkdtemp(join(tmpdir(), "senpi-task20-docs-"));
const child = spawn("npx", ["tsx", "src/cli.ts", "app-server"], {
	cwd: codingAgentDir,
	env: {
		...process.env,
		PI_OFFLINE: "1",
		SENPI_CODING_AGENT_DIR: join(scratchRoot, "agent"),
		SENPI_CODING_AGENT_SESSION_DIR: join(scratchRoot, "sessions"),
	},
	stdio: ["pipe", "pipe", "pipe"],
});
const reader = new LineReader(child);
const exchanges: Exchange[] = [];
const manifest: CapabilityManifest = JSON.parse(await readFile(capabilityManifestPath, "utf8"));
const documentedMethods = new Set(manifest.documentation.methods);

try {
	const initialize = await sendDocumented({
		id: 1,
		method: "initialize",
		params: {
			clientInfo: { name: "task20-docs", title: "Task 20 Docs", version: "0.0.1" },
			capabilities: { experimentalApi: true, requestAttestation: false },
		},
	});
	await sendDocumented({ id: 2, method: "model/list", params: { includeHidden: false } });
	await sendDocumented({ id: 3, method: "remoteControl/status/read" });
	const started = await sendDocumented({ id: 4, method: "thread/start", params: { cwd: join(scratchRoot, "cwd") } });
	const threadId = stringAt(started.response, ["result", "thread", "id"]);
	await sendDocumented({ id: 5, method: "thread/resume", params: { threadId } });
	await sendDocumented({ id: 6, method: "thread/list", params: { limit: 1 } });
	await sendDocumented({ id: 7, method: "thread/loaded/list", params: { limit: 1 } });
	await sendDocumented({ id: 8, method: "thread/read", params: { threadId, includeTurns: false } });
	await sendDocumented({ id: 9, method: "thread/name/set", params: { threadId, name: "Docs example" } });
	await sendDocumented({ id: 10, method: "turn/interrupt", params: { threadId, turnId: "not-active" } });
	await sendDocumented({
		id: 11,
		method: "turn/steer",
		params: { threadId, expectedTurnId: "not-active", input: [{ type: "text", text: "Prefer brevity." }] },
	});
	await sendDocumented({
		id: 12,
		method: "turn/start",
		params: { threadId: "missing-thread", input: [{ type: "text", text: "Say ok." }] },
	});
	const forked = await sendDocumented({
		id: 13,
		method: "thread/fork",
		params: { threadId, cwd: join(scratchRoot, "fork") },
	});
	const forkId = stringAt(forked.response, ["result", "thread", "id"]);
	await sendDocumented({ id: 14, method: "thread/archive", params: { threadId } });
	await sendDocumented({ id: 15, method: "thread/delete", params: { threadId: forkId } });
	await sendDocumented({ id: 16, method: "thread/unsubscribe", params: { threadId } });
	await sendDocumented({ id: 17, method: "thread/search", params: { query: "docs" } });

	if (!("result" in initialize.response)) {
		throw new Error("initialize did not return a result");
	}
	await writeEvidence(exchanges, reader.stderrText());
	validateDocs(await readFile("docs/app-server.md", "utf8"), exchanges);
	if (exchanges.map((exchange) => exchange.method).join("\n") !== manifest.documentation.methods.join("\n")) {
		throw new Error("live documentation exchange order differs from capability manifest");
	}
	console.log(`LIVE_EXCHANGE_COUNT=${exchanges.length}`);
	console.log(`DOCUMENTED_METHODS_VALIDATED=${manifest.documentation.methods.length}`);
	console.log("PASS_DOC_EXAMPLES_MATCH_LIVE_STATUS_AND_KEYS=true");
	console.log(`EVIDENCE_PATH=${evidencePath}`);
} finally {
	child.stdin.end();
	child.kill("SIGTERM");
	await delay(100);
	child.kill("SIGKILL");
	await rm(scratchRoot, { recursive: true, force: true });
}

async function send(request: RpcRequest): Promise<Exchange> {
	child.stdin.write(`${JSON.stringify(request)}\n`);
	for (;;) {
		const line = await reader.nextLine(30_000);
		const message = parseRecord(line, "app-server stdout line");
		if (message.id === request.id) {
			const response = withNumberId(message, `response for ${request.method}`);
			const exchange = { method: request.method, request, response };
			exchanges.push(exchange);
			return exchange;
		}
	}
}

async function sendDocumented(request: RpcRequest): Promise<Exchange> {
	if (!documentedMethods.has(request.method)) {
		throw new Error(`method ${request.method} is missing from capability manifest documentation`);
	}
	return send(request);
}

async function writeEvidence(liveExchanges: readonly Exchange[], stderr: string): Promise<void> {
	await mkdir(resolve(evidencePath, ".."), { recursive: true });
	const lines = [
		"# task20-doc-example-check fresh app-server transcript",
		`cwd=${codingAgentDir}`,
		`exchangeCount=${liveExchanges.length}`,
		...liveExchanges.flatMap((exchange) => [JSON.stringify(exchange.request), JSON.stringify(exchange.response)]),
		"# stderr",
		stderr.trim(),
		"",
	];
	await writeFile(evidencePath, lines.join("\n"));
}
