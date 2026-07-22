import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";

export type WireRecord = { readonly [key: string]: unknown };
export type Observation = { readonly message: WireRecord; readonly index: number };
type MessagePredicate = (message: WireRecord) => boolean;
type Waiter = {
	readonly fromIndex: number;
	readonly predicate: MessagePredicate;
	readonly resolve: (observation: Observation) => void;
	readonly timer: ReturnType<typeof setTimeout>;
};

const QA_PORTS = [18990, 18991, 18992, 18993, 18994, 18995, 18996, 18997, 18998, 18999] as const;
const providerKeys = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"OPENAI_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_CLOUD_API_KEY",
	"GROQ_API_KEY",
	"OPENROUTER_API_KEY",
	"MISTRAL_API_KEY",
	"HF_TOKEN",
] as const;

export class StdioClient {
	readonly messages: WireRecord[] = [];
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly waiters: Waiter[] = [];
	private buffer = "";
	private nextId = 1;

	constructor(child: ChildProcessWithoutNullStreams) {
		this.child = child;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.read(chunk));
		child.stderr.on("data", () => {});
	}

	mark(): number {
		return this.messages.length;
	}

	notify(method: string, params: unknown = {}): void {
		this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
	}

	async request(method: string, params: unknown = {}): Promise<Observation> {
		const observation = await this.rawRequest(method, params);
		if ("error" in observation.message) {
			throw new Error(`${method} failed: ${JSON.stringify(observation.message.error)}`);
		}
		return observation;
	}

	async rawRequest(method: string, params: unknown = {}): Promise<Observation> {
		const id = `task11-${this.nextId}`;
		this.nextId += 1;
		const fromIndex = this.mark();
		this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
		return this.waitForMessage((message) => message.id === id && typeof message.method !== "string", fromIndex);
	}

	waitForMessage(predicate: MessagePredicate, fromIndex = 0): Promise<Observation> {
		for (let index = fromIndex; index < this.messages.length; index += 1) {
			const message = this.messages[index];
			if (message && predicate(message)) return Promise.resolve({ message, index });
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("timed out waiting for app-server message")), 120_000);
			this.waiters.push({ fromIndex, predicate, resolve, timer });
		});
	}

	async close(): Promise<void> {
		this.child.stdin.end();
		if (this.child.exitCode === null && this.child.signalCode === null) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					this.child.kill("SIGKILL");
					resolve();
				}, 5_000);
				this.child.once("close", () => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
		this.child.stdin.destroy();
		this.child.stdout.destroy();
		this.child.stderr.destroy();
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
			const index = this.messages.push(parsed) - 1;
			for (let waiterIndex = this.waiters.length - 1; waiterIndex >= 0; waiterIndex -= 1) {
				const waiter = this.waiters[waiterIndex];
				if (!waiter || index < waiter.fromIndex || !waiter.predicate(parsed)) continue;
				this.waiters.splice(waiterIndex, 1);
				clearTimeout(waiter.timer);
				waiter.resolve({ message: parsed, index });
			}
		}
	}
}

export function spawnAppServer(root: string, agentDir: string, sessionDir: string): ChildProcessWithoutNullStreams {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		SENPI_CODING_AGENT_DIR: agentDir,
		SENPI_CODING_AGENT_SESSION_DIR: sessionDir,
	};
	for (const key of providerKeys) delete env[key];
	const repoRoot = join(process.cwd(), "../..");
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

export async function writeMockModels(agentDir: string, port: number): Promise<void> {
	const baseUrl = `http://127.0.0.1:${port}/v1`;
	await writeFile(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				mock: {
					baseUrl,
					apiKey: "local-qa-key",
					api: "openai-completions",
					models: [
						{
							id: "mock-model",
							baseUrl,
							api: "openai-completions",
							contextWindow: 1_000_000,
							maxTokens: 4096,
						},
					],
				},
			},
		}),
	);
}

export function longTranscript(): string {
	return Array.from({ length: 3_000 }, (_, index) => `fixture-${index} alpha beta gamma delta`).join(" ");
}

export type FakeModel = { readonly port: number; readonly stop: () => Promise<void> };

export async function startFakeModel(): Promise<FakeModel> {
	for (const port of QA_PORTS) {
		const server = createServer((request, response) => {
			if (request.method === "GET") {
				writeJson(response, { object: "list", data: [{ id: "mock-model" }] });
				return;
			}
			let ignored = 0;
			request.on("data", (chunk: Buffer) => {
				ignored += chunk.length;
			});
			request.on("end", () => {
				const delayMs = ignored > 0 ? 250 : 0;
				setTimeout(() => writeSse(response), delayMs);
			});
		});
		if (await listen(server, port)) {
			return { port, stop: () => closeServer(server) };
		}
	}
	throw new Error("no free QA port for fake model");
}

function listen(server: Server, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const onError = (): void => {
			server.off("listening", onListening);
			resolve(false);
		};
		const onListening = (): void => {
			server.off("error", onError);
			resolve(true);
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, "127.0.0.1");
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => {
		server.closeAllConnections();
		server.close(() => resolve());
		server.unref();
	});
}

function writeJson(response: ServerResponse, value: WireRecord): void {
	response.writeHead(200, { "content-type": "application/json" });
	response.end(JSON.stringify(value));
}

function writeSse(response: ServerResponse): void {
	response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const base = { id: "local-qa", object: "chat.completion.chunk", created: 0, model: "mock-model" };
	const send = (delta: WireRecord, finishReason: string | null = null): void => {
		const chunk = { ...base, choices: [{ index: 0, delta, finish_reason: finishReason }] };
		response.write(`data: ${JSON.stringify(chunk)}\n\n`);
	};
	send({ role: "assistant", content: "" });
	send({ content: "local compaction summary" });
	send({}, "stop");
	response.write("data: [DONE]\n\n");
	response.end();
}

export function recordAt(value: WireRecord, key: string): WireRecord {
	const child = value[key];
	if (!isRecord(child)) throw new Error(`expected object field ${key}`);
	return child;
}

export function stringAt(value: WireRecord, key: string): string {
	const child = value[key];
	if (typeof child !== "string") throw new Error(`expected string field ${key}`);
	return child;
}

export function stringAtOrNull(value: WireRecord, key: string): string | null {
	const child = value[key];
	return typeof child === "string" ? child : null;
}

export function numberAt(value: WireRecord, key: string): number | null {
	const child = value[key];
	return typeof child === "number" ? child : null;
}

export function isRecord(value: unknown): value is WireRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
