import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type WireRecord = Record<string, unknown>;
type Waiter = {
	readonly id: string;
	readonly resolve: (message: WireRecord) => void;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
};

const providerKeys = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"OPENAI_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"DEEPSEEK_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_CLOUD_API_KEY",
	"GROQ_API_KEY",
	"CEREBRAS_API_KEY",
	"XAI_API_KEY",
	"OPENROUTER_API_KEY",
	"AI_GATEWAY_API_KEY",
	"ZAI_API_KEY",
	"MISTRAL_API_KEY",
	"MINIMAX_API_KEY",
	"MOONSHOT_API_KEY",
	"KIMI_API_KEY",
	"OPENCODE_API_KEY",
	"HF_TOKEN",
] as const;
const repoRoot = join(process.cwd(), "../..");

class StdioClient {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly messages: WireRecord[] = [];
	private readonly waiters: Waiter[] = [];
	private nextId = 1;
	private buffer = "";

	constructor(child: ChildProcessWithoutNullStreams) {
		this.child = child;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.read(chunk));
	}

	async request(method: string, params: unknown = {}): Promise<WireRecord> {
		const id = `task8-${this.nextId}`;
		this.nextId += 1;
		this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
		return this.waitForId(id);
	}

	async close(): Promise<void> {
		this.child.stdin.end();
		if (this.child.exitCode !== null || this.child.signalCode !== null) return;
		await new Promise<void>((resolveClose) => {
			const timer = setTimeout(() => {
				this.child.kill("SIGKILL");
				resolveClose();
			}, 5_000);
			this.child.once("close", () => {
				clearTimeout(timer);
				resolveClose();
			});
		});
	}

	private waitForId(id: string): Promise<WireRecord> {
		const existing = this.messages.find((message) => message.id === id);
		if (existing) return Promise.resolve(existing);
		return new Promise<WireRecord>((resolveMessage, rejectMessage) => {
			const timer = setTimeout(() => {
				const index = this.waiters.findIndex((waiter) => waiter.id === id);
				if (index >= 0) this.waiters.splice(index, 1);
				rejectMessage(new Error(`timed out waiting for ${id}`));
			}, 30_000);
			this.waiters.push({ id, resolve: resolveMessage, reject: rejectMessage, timer });
		});
	}

	private read(chunk: string): void {
		this.buffer += chunk;
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (!line) continue;
			const parsed: unknown = JSON.parse(line);
			if (!isRecord(parsed)) continue;
			this.messages.push(parsed);
			const id = parsed.id;
			if (typeof id !== "string") continue;
			const waiterIndex = this.waiters.findIndex((waiter) => waiter.id === id);
			const waiter = waiterIndex < 0 ? undefined : this.waiters.splice(waiterIndex, 1)[0];
			if (!waiter) continue;
			clearTimeout(waiter.timer);
			waiter.resolve(parsed);
		}
	}
}

async function main(): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "senpi-task8-search-"));
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	const cwd = join(root, "cwd");
	await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(sessionDir, { recursive: true }), mkdir(cwd)]);
	const activeId = "40000000-0000-4000-8000-000000000001";
	const archivedId = "40000000-0000-4000-8000-000000000002";
	await writeSession(sessionDir, activeId, "Wire NEEDLE hit");
	await writeSession(sessionDir, archivedId, "Archived needle hit");

	const enabled = new StdioClient(spawnServer(root, agentDir, sessionDir, true));
	const disabled = new StdioClient(spawnServer(root, agentDir, sessionDir, false));
	try {
		await initialize(enabled, "task8-enabled");
		await initialize(disabled, "task8-disabled");
		const archive = await enabled.request("thread/archive", { threadId: archivedId });
		assertResult(archive, "thread/archive");

		const search = await enabled.request("thread/search", { searchTerm: "  needle  " });
		const searchResult = resultRecord(search, "thread/search");
		const data = arrayValue(searchResult.data);
		const first = recordValue(data[0]);
		const snippet = typeof first?.snippet === "string" ? first.snippet : "";
		const empty = await enabled.request("thread/search", { searchTerm: "   " });
		const gated = await disabled.request("thread/search", { searchTerm: "needle" });

		const emptyCode = errorCode(empty);
		const gateMessage = errorMessage(gated);
		const searchHits = data.length;
		const snippetMatch = snippet.toLowerCase().includes("needle");
		const gateEnforced = gateMessage.includes("experimentalApi");
		console.log(`SEARCH_HITS=${searchHits}`);
		console.log(`SNIPPET_MATCH=${snippetMatch ? 1 : 0}`);
		console.log(`EMPTY_TERM_CODE=${emptyCode ?? "INVALID"}`);
		console.log(`GATE_ENFORCED=${gateEnforced ? 1 : 0}`);
		if (searchHits < 1 || !snippetMatch || (emptyCode !== -32600 && emptyCode !== -32602) || !gateEnforced) {
			throw new Error("task8 search assertions failed");
		}
	} finally {
		await Promise.all([enabled.close(), disabled.close()]);
		await rm(root, { recursive: true, force: true });
	}
}

function spawnServer(
	root: string,
	agentDir: string,
	sessionDir: string,
	experimentalApi: boolean,
): ChildProcessWithoutNullStreams {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		SENPI_CODING_AGENT_DIR: agentDir,
		SENPI_CODING_AGENT_SESSION_DIR: sessionDir,
		SENPI_TASK8_EXPERIMENTAL: experimentalApi ? "1" : "0",
	};
	for (const key of providerKeys) delete env[key];
	return spawn(
		process.execPath,
		[
			join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
			"--tsconfig",
			join(repoRoot, "tsconfig.json"),
			join(repoRoot, "packages", "coding-agent", "src", "cli.ts"),
			"app-server",
		],
		{ cwd: root, env, stdio: ["pipe", "pipe", "pipe"] },
	);
}

async function initialize(client: StdioClient, name: string): Promise<void> {
	const response = await client.request("initialize", {
		clientInfo: { name, title: name, version: "0.0.0" },
		capabilities: { experimentalApi: name === "task8-enabled", requestAttestation: false },
	});
	assertResult(response, "initialize");
}

async function writeSession(sessionDir: string, threadId: string, text: string): Promise<void> {
	await writeFile(
		join(sessionDir, `2026-07-02T00-00-00-000Z_${threadId}.jsonl`),
		[
			JSON.stringify({
				type: "session",
				version: 3,
				id: threadId,
				timestamp: "2026-07-02T00:00:00.000Z",
				cwd: sessionDir,
			}),
			JSON.stringify({
				type: "message",
				id: `message-${threadId}`,
				parentId: threadId,
				timestamp: "2026-07-02T00:00:01.000Z",
				message: { role: "user", content: [{ type: "text", text }] },
			}),
			"",
		].join("\n"),
	);
}

function resultRecord(response: WireRecord, method: string): WireRecord {
	if ("error" in response) throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
	return recordValue(response.result) ?? {};
}

function assertResult(response: WireRecord, method: string): void {
	if ("error" in response) throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
}

function errorCode(response: WireRecord): number | null {
	const error = recordValue(response.error);
	return typeof error?.code === "number" ? error.code : null;
}

function errorMessage(response: WireRecord): string {
	const error = recordValue(response.error);
	return typeof error?.message === "string" ? error.message : "";
}

function arrayValue(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

function recordValue(value: unknown): WireRecord | null {
	if (!isRecord(value)) return null;
	return value;
}

function isRecord(value: unknown): value is WireRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

main()
	.then(() => {
		process.exit(0);
	})
	.catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
