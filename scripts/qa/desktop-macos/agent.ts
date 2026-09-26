import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { QA_MODEL, QA_PROVIDER } from "./provider.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, "..", "..", "..");
const CLI = join(REPO, "packages", "coding-agent", "src", "cli.ts");
const PROVIDER = join(HERE, "provider.ts");
/** Hang guard of one awaited agent event; it never times behavior. */
const EVENT_DEADLINE_MS = 120_000;

export type Json = Readonly<Record<string, unknown>>;

export function isRecord(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What one `computer` tool call returned, as coding-agent emitted it on `tool_execution_end`. */
export interface ToolOutcome {
	readonly isError: boolean;
	readonly text: string;
	/** Inline images of the result: base64 `data` as the model received it. */
	readonly images: readonly { readonly mimeType: string; readonly data: string }[];
	readonly details: Json;
}

function toolOutcome(event: Json): ToolOutcome {
	const result = isRecord(event.result) ? event.result : {};
	const content = Array.isArray(result.content) ? result.content.filter(isRecord) : [];
	return {
		isError: event.isError === true,
		text: content.flatMap((part) => (typeof part.text === "string" ? [part.text] : [])).join("\n"),
		images: content.flatMap(({ mimeType, data }) =>
			typeof mimeType === "string" && typeof data === "string" ? [{ mimeType, data }] : [],
		),
		details: isRecord(result.details) ? result.details : {},
	};
}

/** An isolated agent home: `agent/settings.json` carries the `computer` block; sessions and the audit land inside. */
interface AgentHome {
	readonly home: string;
	readonly env: NodeJS.ProcessEnv;
}

function agentHome(computer: Json): AgentHome {
	const home = mkdtempSync(join(tmpdir(), "senpi-qa-desktop-"));
	const agentDir = join(home, "agent");
	mkdirSync(agentDir, { recursive: true });
	const settings = { computer, compaction: { enabled: false }, retry: { enabled: false } };
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
	return { home, env: { SENPI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" } };
}

/** `bun` arguments of the coding-agent CLI with the scripted QA model and the real builtins. */
const AGENT_ARGS = [
	CLI,
	"--mode",
	"rpc",
	"--offline",
	"--no-context-files",
	"--no-extensions",
	"--no-skills",
	"--no-prompt-templates",
	"--no-themes",
	"--provider",
	QA_PROVIDER,
	"--model",
	QA_MODEL,
	"--permission",
	"computer=allow",
	"-e",
	PROVIDER,
];

/** Every line of the engine's persisted audit log under `home` (read from disk, not from the tool). */
function auditLog(home: string): readonly Json[] {
	const file = readdirSync(home, { recursive: true, encoding: "utf8" }).find((path) =>
		path.endsWith(".computer-audit.jsonl"),
	);
	if (file === undefined) return [];
	const lines = readFileSync(join(home, file), "utf8").split("\n").filter(Boolean);
	return lines.map((line): unknown => JSON.parse(line)).filter(isRecord);
}

interface Waiter {
	readonly predicate: (event: Json) => boolean;
	readonly resolve: (event: Json) => void;
	readonly reject: (error: Error) => void;
}

/**
 * One coding-agent process in `--mode rpc` (the interactive form of `--mode json`: the same JSON event stream,
 * plus stdin commands) with the scripted QA model, the real builtins, and the given `computer` settings block.
 */
export class AgentSession {
	readonly #child;
	readonly #waiters = new Set<Waiter>();
	readonly #home: string;
	readonly #exited: Promise<void>;
	#stderr = "";
	#nextId = 0;

	constructor(computer: Json) {
		const { home, env } = agentHome(computer);
		this.#home = home;
		const options = { cwd: home, env: { ...process.env, ...env }, stdio: "pipe" } as const;
		this.#child = spawn("bun", AGENT_ARGS, options);
		this.#child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			this.#stderr += chunk;
		});
		this.#exited = new Promise((resolve) => {
			this.#child.once("close", (code, signal) => {
				this.#failAll(new Error(`agent exited ${code ?? signal}`));
				resolve();
			});
		});
		createInterface({ input: this.#child.stdout }).on("line", (line) => {
			if (!line.startsWith("{")) return;
			const event: unknown = JSON.parse(line);
			if (!isRecord(event)) return;
			for (const waiter of [...this.#waiters].filter((candidate) => candidate.predicate(event))) {
				this.#waiters.delete(waiter);
				waiter.resolve(event);
			}
		});
	}

	#failAll(error: Error): void {
		for (const waiter of this.#waiters) waiter.reject(new Error(`${error.message}; stderr=${this.#stderr}`));
		this.#waiters.clear();
	}

	/** Registers before the caller triggers the event, so no event can be missed. */
	waitFor(predicate: (event: Json) => boolean): Promise<Json> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#waiters.delete(waiter);
				reject(new Error(`agent event deadline exceeded; stderr=${this.#stderr}`));
			}, EVENT_DEADLINE_MS);
			const settle = (then: () => void) => {
				clearTimeout(timer);
				then();
			};
			const waiter: Waiter = {
				predicate,
				resolve: (event) => settle(() => resolve(event)),
				reject: (error) => settle(() => reject(error)),
			};
			this.#waiters.add(waiter);
		});
	}

	async #send(command: Json): Promise<Json> {
		this.#nextId += 1;
		const id = `qa-${this.#nextId}`;
		const response = this.waitFor((event) => event.type === "response" && event.id === id);
		this.#child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		const reply = await response;
		if (reply.success !== true) throw new Error(`rpc ${String(command.type)} failed: ${JSON.stringify(reply)}`);
		return reply;
	}

	/** `/computer <args>` as the user would send it over rpc; resolves with the notification it produced. */
	async command(args: string): Promise<string> {
		const notified = this.waitFor((event) => event.type === "extension_ui_request" && event.method === "notify");
		await this.#send({ type: "prompt", message: `/computer ${args}` });
		return String((await notified).message);
	}

	/** One model turn that makes exactly one `computer` call with `args`; resolves when the turn ends. */
	async call(args: Json): Promise<ToolOutcome> {
		const ended = this.waitFor((event) => event.type === "tool_execution_end" && event.toolName === "computer");
		const settled = this.waitFor((event) => event.type === "agent_end");
		await this.#send({ type: "prompt", message: JSON.stringify(args) });
		const [end] = await Promise.all([ended, settled]);
		return toolOutcome(end);
	}

	/** The engine's persisted audit log of this session. */
	auditLog(): readonly Json[] {
		return auditLog(this.#home);
	}

	async close(): Promise<void> {
		this.#child.kill("SIGTERM");
		const kill = setTimeout(() => this.#child.kill("SIGKILL"), 30_000);
		await this.#exited;
		clearTimeout(kill);
	}
}
