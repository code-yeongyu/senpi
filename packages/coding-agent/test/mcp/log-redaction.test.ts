import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createMcpLogger,
	fingerprintSecret,
	mapMcpLogLevel,
	redactMcpLogText,
} from "../../src/core/extensions/builtin/mcp/log.ts";

const ORIGINAL_AGENT_DIR = process.env.SENPI_CODING_AGENT_DIR;

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

	it("masks malformed secret-bearing input", () => {
		const token = "malformed-token-value";
		const redacted = redactMcpLogText(`Authorization: Bearer ${token}
{"api_key":"${token}"}
https://example.invalid/path?client_secret=${token}`);

		expect(redacted).not.toContain(token);
		expect(redacted).toContain(`<redacted:${fingerprintSecret(token)}>`);
	});

	it("keeps the last 200 ring buffer lines and rotates the 0600 file at the cap", () => {
		const logger = createMcpLogger("rotation/server", { maxFileBytes: 640 });

		for (let index = 0; index < 260; index += 1) {
			logger.debug(`line ${index.toString().padStart(3, "0")}`);
		}

		const ring = logger.getRingBuffer();
		expect(ring).toHaveLength(200);
		expect(ring[0]).toContain("line 060");
		expect(ring.at(-1)).toContain("line 259");
		expect(existsSync(`${logger.filePath}.1`)).toBe(true);
		expect(statSync(logger.filePath).size).toBeLessThanOrEqual(640);
		expect(statSync(logger.filePath).mode & 0o777).toBe(0o600);
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
