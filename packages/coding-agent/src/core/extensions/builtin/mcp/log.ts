import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../../../config.ts";

export type McpLogLevel = "debug" | "info" | "notice" | "warning" | "error" | "critical" | "alert" | "emergency";
export type McpLogChannel = "client" | "server" | "stderr" | "file";

export interface McpLogLevelMapping {
	level: McpLogLevel;
	severity: number;
}

export interface McpLogger {
	readonly filePath: string;
	debug(message: string, data?: unknown): void;
	info(message: string, data?: unknown): void;
	warn(message: string, data?: unknown): void;
	error(message: string, data?: unknown): void;
	stderr(message: string, data?: unknown): void;
	log(level: string, message: string, data?: unknown, channel?: McpLogChannel): void;
	getRingBuffer(): string[];
}

export interface McpLoggerOptions {
	logDir?: string;
	maxFileBytes?: number;
}

interface RedactionContext {
	readonly seen: WeakSet<object>;
	readonly secrets: Set<string>;
}

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const MAX_RING_LINES = 200;
const SENSITIVE_KEY_PATTERN =
	/(?:^|[_-])(?:api[_-]?key|key|token|secret|password|client_secret|auth|authorization)(?:$|[_-])/i;
const QUERY_SECRET_PATTERN =
	/([?&][^=\s&"'<>]*(?:key|token|secret|password|client_secret|auth)[^=\s&"'<>]*=)([^&\s"'<>]+)/gi;
const AUTHORIZATION_VALUE_PATTERN =
	/((?:"|')?\bAuthorization(?:"|')?\s*[:=]\s*(?:"|')?(?:[A-Za-z][A-Za-z0-9+.-]*\s+)?)(?!<redacted:)([^"',\s}\]&]+)/gi;
const BEARER_VALUE_PATTERN = /(\bBearer\s+)(?!<redacted:)([A-Za-z0-9._~+/=-]+)/gi;
const KEY_VALUE_PATTERN =
	/((?:"|')?[^"'\s:=,{}]*(?:api[_-]?key|key|token|secret|password|client_secret|auth)[^"'\s:=,{}]*(?:"|')?\s*[:=]\s*(?:"|')?)([^"',\s}\]&]+)/gi;

export function createMcpLogger(server: string, options: McpLoggerOptions = {}): McpLogger {
	return new FileMcpLogger(server, options);
}

export function getMcpLogDir(): string {
	return join(getAgentDir(), "logs", "mcp");
}

export function fingerprintSecret(secret: string): string {
	return createHash("sha256").update(secret).digest("hex").slice(0, 8);
}

export function redactMcpLogText(text: string): string {
	return redactMcpLogTextWithContext(text, { seen: new WeakSet<object>(), secrets: new Set<string>() });
}

function redactMcpLogTextWithContext(text: string, context: RedactionContext): string {
	return text
		.replace(
			AUTHORIZATION_VALUE_PATTERN,
			(_match, prefix: string, secret: string) => `${prefix}${redactionForSecret(secret, context)}`,
		)
		.replace(
			BEARER_VALUE_PATTERN,
			(_match, prefix: string, secret: string) => `${prefix}${redactionForSecret(secret, context)}`,
		)
		.replace(
			QUERY_SECRET_PATTERN,
			(_match, prefix: string, secret: string) => `${prefix}${redactionForSecret(secret, context)}`,
		)
		.replace(KEY_VALUE_PATTERN, (match: string, prefix: string, secret: string) =>
			secret.startsWith("<redacted:") || /\bAuthorization\b/i.test(prefix)
				? match
				: `${prefix}${redactionForSecret(secret, context)}`,
		);
}

export function mapMcpLogLevel(level: string): McpLogLevelMapping {
	switch (level) {
		case "emergency":
			return { level: "emergency", severity: 0 };
		case "alert":
			return { level: "alert", severity: 1 };
		case "critical":
		case "crit":
			return { level: "critical", severity: 2 };
		case "error":
		case "err":
			return { level: "error", severity: 3 };
		case "warning":
		case "warn":
			return { level: "warning", severity: 4 };
		case "notice":
			return { level: "notice", severity: 5 };
		case "informational":
		case "info":
			return { level: "info", severity: 6 };
		case "debug":
			return { level: "debug", severity: 7 };
		default:
			return { level: "info", severity: 6 };
	}
}

class FileMcpLogger implements McpLogger {
	readonly filePath: string;
	readonly #server: string;
	readonly #maxFileBytes: number;
	readonly #ring: string[] = [];
	#fileSinkDisabled = false;

	constructor(server: string, options: McpLoggerOptions) {
		this.#server = server;
		this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
		this.filePath = join(options.logDir ?? getMcpLogDir(), `${sanitizeServerName(server)}.log`);
	}

	debug(message: string, data?: unknown): void {
		this.log("debug", message, data);
	}

	info(message: string, data?: unknown): void {
		this.log("info", message, data);
	}

	warn(message: string, data?: unknown): void {
		this.log("warning", message, data);
	}

	error(message: string, data?: unknown): void {
		this.log("error", message, data);
	}

	stderr(message: string, data?: unknown): void {
		this.log("info", message, data, "stderr");
	}

	log(level: string, message: string, data?: unknown, channel: McpLogChannel = "server"): void {
		const line = this.#formatLine(level, message, data, channel);
		this.#pushRing(line);
		this.#writeFile(line);
	}

	getRingBuffer(): string[] {
		return [...this.#ring];
	}

	#formatLine(level: string, message: string, data: unknown, channel: McpLogChannel): string {
		const context: RedactionContext = { seen: new WeakSet<object>(), secrets: new Set<string>() };
		const mapped = mapMcpLogLevel(level);
		const redactedData = data === undefined ? undefined : redactMcpLogData(data, context);
		const entry = {
			timestamp: new Date().toISOString(),
			server: this.#server,
			level: mapped.level,
			severity: mapped.severity,
			channel,
			message: redactMcpLogTextWithContext(message, context),
			data: redactedData,
		};
		return redactKnownSecrets(JSON.stringify(entry), context);
	}

	#pushRing(line: string): void {
		this.#ring.push(line);
		if (this.#ring.length > MAX_RING_LINES) {
			this.#ring.splice(0, this.#ring.length - MAX_RING_LINES);
		}
	}

	#writeFile(line: string): void {
		if (this.#fileSinkDisabled) return;
		try {
			mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
			const bytes = Buffer.byteLength(`${line}\n`);
			this.#rotateIfNeeded(bytes);
			const fd = openSync(this.filePath, "a", 0o600);
			try {
				writeSync(fd, `${line}\n`);
			} finally {
				closeSync(fd);
			}
			chmodSync(this.filePath, 0o600);
		} catch (error) {
			this.#fileSinkDisabled = true;
			const reason = error instanceof Error ? error.message : String(error);
			this.#pushRing(this.#formatLine("warning", `file sink disabled: ${reason}`, undefined, "file"));
		}
	}

	#rotateIfNeeded(incomingBytes: number): void {
		if (this.#maxFileBytes <= 0 || !existsSync(this.filePath)) return;
		if (statSync(this.filePath).size + incomingBytes <= this.#maxFileBytes) return;
		try {
			rmSync(`${this.filePath}.1`, { force: true });
			renameSync(this.filePath, `${this.filePath}.1`);
			chmodSync(`${this.filePath}.1`, 0o600);
		} catch {}
	}
}

function redactMcpLogData(value: unknown, context: RedactionContext): unknown {
	if (typeof value === "string") return redactMcpLogTextWithContext(value, context);
	if (typeof value === "bigint") return value.toString();
	if (typeof value !== "object" || value === null) return value;
	if (context.seen.has(value)) return "[Circular]";
	context.seen.add(value);
	if (value instanceof Error) return redactMcpLogError(value, context);
	if (Array.isArray(value)) return value.map((item) => redactMcpLogData(item, context));
	return redactMcpLogEntries(value, context);
}

function redactMcpLogError(error: Error, context: RedactionContext): Record<string, unknown> {
	const redacted = redactMcpLogEntries(error, context);
	redacted.name = redactMcpLogTextWithContext(error.name, context);
	redacted.message = redactKnownSecrets(redactMcpLogTextWithContext(error.message, context), context);
	if (error.stack !== undefined) {
		redacted.stack = redactKnownSecrets(redactMcpLogTextWithContext(error.stack, context), context);
	}
	return redacted;
}

function redactMcpLogEntries(value: object, context: RedactionContext): Record<string, unknown> {
	const redacted: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (SENSITIVE_KEY_PATTERN.test(key)) {
			redacted[key] = redactionForSecret(stringifySecretValue(item), context);
		} else {
			redacted[key] = redactMcpLogData(item, context);
		}
	}
	return redacted;
}

function stringifySecretValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
	const seen = new WeakSet<object>();
	const json = JSON.stringify(value, (_key: string, item: unknown) => {
		if (typeof item === "bigint") return item.toString();
		if (typeof item !== "object" || item === null) return item;
		if (seen.has(item)) return "[Circular]";
		seen.add(item);
		return item;
	});
	return json ?? String(value);
}

function redactionForSecret(secret: string, context: RedactionContext): string {
	if (secret.length > 0 && !secret.startsWith("<redacted:")) {
		context.secrets.add(secret);
	}
	return redactionFor(secret);
}

function redactKnownSecrets(text: string, context: RedactionContext): string {
	for (const secret of [...context.secrets].sort((left, right) => right.length - left.length)) {
		text = text.split(secret).join(redactionFor(secret));
	}
	return text;
}

function redactionFor(secret: string): string {
	return `<redacted:${fingerprintSecret(secret)}>`;
}

function sanitizeServerName(server: string): string {
	return server.replace(/[^A-Za-z0-9._-]+/g, "_") || "server";
}
