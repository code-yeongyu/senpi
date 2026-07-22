import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export type WireRecord = Record<string, unknown>;

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

export class StdioClient {
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
				this.killProcessGroup();
			}, 5_000);
			this.child.once("close", () => {
				clearTimeout(timer);
				resolveClose();
			});
		});
	}

	private killProcessGroup(): void {
		const pid = this.child.pid;
		if (pid !== undefined && process.platform !== "win32") {
			try {
				process.kill(-pid, "SIGKILL");
				return;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException | undefined)?.code;
				if (code !== "ESRCH") throw error;
			}
		}
		this.child.kill("SIGKILL");
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

export function spawnServer(
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
		{ cwd: root, env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" },
	);
}

export async function initialize(client: StdioClient, name: string): Promise<void> {
	const response = await client.request("initialize", {
		clientInfo: { name, title: name, version: "0.0.0" },
		capabilities: { experimentalApi: name === "task8-enabled", requestAttestation: false },
	});
	if ("error" in response) throw new Error(`initialize failed: ${JSON.stringify(response.error)}`);
}

export type SessionOptions = {
	readonly userTimestamp?: string;
	readonly assistantTimestamp?: string;
};

export async function writeSession(
	sessionDir: string,
	threadId: string,
	text: string,
	options: SessionOptions = {},
): Promise<void> {
	const messages = [
		JSON.stringify({
			type: "message",
			id: `message-${threadId}`,
			parentId: threadId,
			timestamp: options.userTimestamp ?? "2026-07-02T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text }] },
		}),
	];
	if (options.assistantTimestamp) {
		messages.push(
			JSON.stringify({
				type: "message",
				id: `assistant-${threadId}`,
				parentId: `message-${threadId}`,
				timestamp: options.assistantTimestamp,
				message: { role: "assistant", content: [{ type: "text", text: "assistant activity" }] },
			}),
		);
	}
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
			...messages,
			"",
		].join("\n"),
	);
}

function isRecord(value: unknown): value is WireRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
