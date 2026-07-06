import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createMcpLogger,
	fingerprintSecret,
	mapMcpLogLevel,
	redactMcpLogText,
} from "../../src/core/extensions/builtin/mcp/log.ts";

const ORIGINAL_AGENT_DIR = process.env.SENPI_CODING_AGENT_DIR;

function expectedRedaction(secret: string): string {
	return `<redacted:${createHash("sha256").update(secret).digest("hex").slice(0, 8)}>`;
}

describe("mcp log redaction", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-mcp-log-"));
		process.env.SENPI_CODING_AGENT_DIR = join(tempDir, "agent");
	});

	afterEach(() => {
		if (ORIGINAL_AGENT_DIR === undefined) {
			delete process.env.SENPI_CODING_AGENT_DIR;
		} else {
			process.env.SENPI_CODING_AGENT_DIR = ORIGINAL_AGENT_DIR;
		}
		chmodSync(tempDir, 0o700);
		rmSync(tempDir, { force: true, recursive: true });
	});

	it("redacts secrets before writing to ring buffer or file", () => {
		const logger = createMcpLogger("alpha");
		const bearer = "abc123";
		const urlSecret = "url-secret-456";
		const jsonSecret = "json-secret-789";

		logger.info("request Authorization: Bearer abc123");
		logger.stderr(`stderr from https://example.test/mcp?api_key=${urlSecret}&safe=value`);
		logger.warn("json payload", {
			headers: { Authorization: `Bearer ${bearer}` },
			body: { client_secret: jsonSecret, nested: { password: "pw-secret" } },
		});

		const ringText = logger.getRingBuffer().join("\n");
		const fileText = readFileSync(logger.filePath, "utf8");

		for (const sinkText of [ringText, fileText]) {
			expect(sinkText).not.toContain(bearer);
			expect(sinkText).not.toContain(urlSecret);
			expect(sinkText).not.toContain(jsonSecret);
			expect(sinkText).toContain(`<redacted:${fingerprintSecret(bearer)}>`);
			expect(sinkText).toContain(`<redacted:${fingerprintSecret(urlSecret)}>`);
			expect(sinkText).toContain(`<redacted:${fingerprintSecret(jsonSecret)}>`);
			expect(sinkText).toContain('"channel":"stderr"');
		}
	});

	it("redacts Error messages and nested cyclic payloads before writing to ring buffer or file", () => {
		const logger = createMcpLogger("wave0-error-cyclic");
		const secret = "wave0-debug-fake-secret-20260706";
		const payload: { headers: { Authorization: string }; password: string; url: string; self?: unknown } = {
			headers: { Authorization: `Bearer ${secret}` },
			password: secret,
			url: `https://example.test/mcp?api_key=${secret}`,
		};
		payload.self = payload;
		const error = Object.assign(new Error(`request failed for ${secret}`), {
			detail: `nested payload still included ${secret}`,
			payload,
		});

		logger.error("plugin call failed", error);

		const ringText = logger.getRingBuffer().join("\n");
		const fileText = readFileSync(logger.filePath, "utf8");
		for (const sinkText of [ringText, fileText]) {
			expect(sinkText).not.toContain(secret);
			expect(sinkText).toContain(expectedRedaction(secret));
			expect(sinkText).toContain('"message":"request failed for <redacted:');
			expect(sinkText).toContain('"stack":"Error: request failed for <redacted:');
			expect(sinkText).toContain("[Circular]");
		}
	});

	it("masks malformed secret-bearing input", () => {
		const token = "malformed-token-value";
		const redacted = redactMcpLogText(`Authorization: Bearer ${token}
{"api_key":"${token}"}
https://example.invalid/path?client_secret=${token}`);

		expect(redacted).not.toContain(token);
		expect(redacted).toContain(expectedRedaction(token));
		expect(fingerprintSecret(token)).toBe(expectedRedaction(token).slice("<redacted:".length, -1));
	});

	it("redacts non-bearer authorization header values", () => {
		const secret = "abc123";

		const redacted = redactMcpLogText(`Authorization: Basic ${secret}`);

		expect(redacted).not.toContain(secret);
		expect(redacted).toBe(`Authorization: Basic ${expectedRedaction(secret)}`);
	});

	it("serializes BigInt data without dropping the log entry", () => {
		const logger = createMcpLogger("bigint-data");
		const secret = "abc123";

		expect(() =>
			logger.info("request Authorization: Basic abc123", {
				headers: { Authorization: `Basic ${secret}` },
				count: 1n,
				nested: { values: [2n] },
			}),
		).not.toThrow();

		const ringText = logger.getRingBuffer().join("\n");
		const fileText = readFileSync(logger.filePath, "utf8");
		for (const sinkText of [ringText, fileText]) {
			expect(sinkText).not.toContain(secret);
			expect(sinkText).toContain(expectedRedaction(secret));
			expect(sinkText).toContain('"count":"1"');
			expect(sinkText).toContain('"values":["2"]');
		}
	});

	it("redacts sensitive object values that contain BigInt data", () => {
		const logger = createMcpLogger("sensitive-bigint");
		const auth: { count: bigint; self?: unknown } = { count: 1n };
		auth.self = auth;

		expect(() => logger.info("probe", { auth })).not.toThrow();

		const ringText = logger.getRingBuffer().join("\n");
		const fileText = readFileSync(logger.filePath, "utf8");
		for (const sinkText of [ringText, fileText]) {
			expect(sinkText).toContain(expectedRedaction('{"count":"1","self":"[Circular]"}'));
			expect(sinkText).not.toContain('"count":"1"');
			expect(sinkText).not.toContain("[Circular]");
		}
	});

	it("keeps the last 200 ring buffer lines and rotates the 0600 file at the cap", () => {
		const logger = createMcpLogger("rotation/server", { maxFileBytes: 640 });

		for (let index = 0; index < 260; index += 1) {
			logger.debug(`line ${index.toString().padStart(3, "0")}`);
		}

		const ring = logger.getRingBuffer();
		expect(ring).toHaveLength(200);
		expect(ring[0]).toContain("line 060");
		expect(ring[ring.length - 1]).toContain("line 259");
		expect(existsSync(`${logger.filePath}.1`)).toBe(true);
		expect(statSync(logger.filePath).size).toBeLessThanOrEqual(640);
		expect(statSync(logger.filePath).mode & 0o777).toBe(0o600);
	});

	it("warns and disables the file sink when rotation fails without leaking secrets", () => {
		const logger = createMcpLogger("rotation-failure", { maxFileBytes: 8 });
		const secret = "rotation-failure-token";
		mkdirSync(dirname(logger.filePath), { recursive: true });
		writeFileSync(logger.filePath, "old line\n", { mode: 0o600 });
		mkdirSync(`${logger.filePath}.1`);

		expect(() => logger.info(`new Authorization: Bearer ${secret}`)).not.toThrow();

		const ringText = logger.getRingBuffer().join("\n");
		expect(ringText).not.toContain(secret);
		expect(ringText).toContain(expectedRedaction(secret));
		expect(ringText).toContain("new Authorization: Bearer <redacted:");
		expect(ringText.match(/file sink disabled/g)).toHaveLength(1);
		expect(readFileSync(logger.filePath, "utf8")).not.toContain(secret);
		expect(statSync(`${logger.filePath}.1`).isDirectory()).toBe(true);
	});

	it("maps MCP RFC-5424 levels to severities", () => {
		expect(mapMcpLogLevel("emergency")).toEqual({ level: "emergency", severity: 0 });
		expect(mapMcpLogLevel("alert")).toEqual({ level: "alert", severity: 1 });
		expect(mapMcpLogLevel("critical")).toEqual({ level: "critical", severity: 2 });
		expect(mapMcpLogLevel("error")).toEqual({ level: "error", severity: 3 });
		expect(mapMcpLogLevel("warning")).toEqual({ level: "warning", severity: 4 });
		expect(mapMcpLogLevel("notice")).toEqual({ level: "notice", severity: 5 });
		expect(mapMcpLogLevel("informational")).toEqual({ level: "info", severity: 6 });
		expect(mapMcpLogLevel("debug")).toEqual({ level: "debug", severity: 7 });
		expect(mapMcpLogLevel("unknown")).toEqual({ level: "info", severity: 6 });
	});

	it("degrades to ring-buffer-only with one warning when the sink is unwritable", () => {
		const agentDir = process.env.SENPI_CODING_AGENT_DIR;
		expect(agentDir).toBeDefined();
		const logDir = join(agentDir!, "logs", "mcp");
		chmodSync(join(agentDir!, ".."), 0o500);

		const logger = createMcpLogger("unwritable", { logDir });

		expect(() => {
			logger.info("first message");
			logger.info("second message");
		}).not.toThrow();

		const ringText = logger.getRingBuffer().join("\n");
		expect(ringText).toContain("first message");
		expect(ringText).toContain("second message");
		expect(ringText.match(/file sink disabled/g)).toHaveLength(1);
		expect(existsSync(logger.filePath)).toBe(false);
	});
});
