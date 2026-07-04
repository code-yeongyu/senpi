import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR, getDebugLogPath } from "../src/config.ts";
import { restoreStderr, takeOverStderr } from "../src/core/output-guard.ts";
import {
	restoreInteractiveStderr,
	takeOverInteractiveStderr,
} from "../src/modes/interactive/interactive-stderr-guard.ts";

const originalStderrWrite = process.stderr.write;
const originalAgentDir = process.env[ENV_AGENT_DIR];
const githubFineGrainedPat = "github_pat_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const tempDirs: string[] = [];

function replaceStderrWrite(write: typeof process.stderr.write): void {
	Object.defineProperty(process.stderr, "write", {
		configurable: true,
		value: write,
		writable: true,
	});
}

function createCapturingStderrWrite(capture: (text: string) => void): typeof process.stderr.write {
	return ((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		capture(String(chunk));
		if (typeof encodingOrCallback === "function") {
			encodingOrCallback(null);
		} else {
			callback?.(null);
		}
		return true;
	}) satisfies typeof process.stderr.write;
}

afterEach(() => {
	restoreInteractiveStderr();
	restoreStderr();
	replaceStderrWrite(originalStderrWrite);
	if (originalAgentDir === undefined) {
		delete process.env[ENV_AGENT_DIR];
	} else {
		process.env[ENV_AGENT_DIR] = originalAgentDir;
	}
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { force: true, recursive: true });
	}
});

describe("interactive stderr guard", () => {
	it("hides direct runtime stderr while the TUI owns the terminal and restores it afterwards", () => {
		let terminalText = "";
		const hiddenDiagnostics: string[] = [];
		replaceStderrWrite(
			createCapturingStderrWrite((text) => {
				terminalText += text;
			}),
		);

		takeOverStderr((text) => hiddenDiagnostics.push(text));
		process.stderr.write("omo-senpi ulw-loop status ignored { reason: 'non-zero-exit', code: 1 }\n");
		process.stderr.write(Buffer.from("omo-senpi ulw-loop continuation skipped { reason: 'inactive' }\n"));

		expect(terminalText).toBe("");
		expect(hiddenDiagnostics.join("")).toContain("status ignored");
		expect(hiddenDiagnostics.join("")).toContain("continuation skipped");

		restoreStderr();
		process.stderr.write("real shutdown error\n");
		expect(terminalText).toContain("real shutdown error");
	});

	it("reports hidden diagnostic sink failures to stderr callbacks", () => {
		let callbackError: Error | null | undefined;
		let terminalText = "";
		replaceStderrWrite(
			createCapturingStderrWrite((text) => {
				terminalText += text;
			}),
		);

		takeOverStderr(() => {
			throw new Error("debug log unavailable");
		});
		const accepted = process.stderr.write("runtime diagnostic\n", (error?: Error | null) => {
			callbackError = error;
		});

		expect(accepted).toBe(false);
		expect(callbackError).toBeInstanceOf(Error);
		expect(callbackError?.message).toBe("debug log unavailable");
		expect(terminalText).toBe("runtime diagnostic\n");
	});

	it("falls back to stderr when hidden diagnostics cannot be saved", () => {
		let terminalText = "";
		replaceStderrWrite(
			createCapturingStderrWrite((text) => {
				terminalText += text;
			}),
		);

		takeOverStderr(
			() => {
				throw new Error("debug log unavailable");
			},
			(text) => text.replace("stderr-secret", "[REDACTED]"),
		);
		const accepted = process.stderr.write("SECRET_TOKEN=stderr-secret\n");

		expect(accepted).toBe(false);
		expect(terminalText).toBe("SECRET_TOKEN=[REDACTED]\n");
		expect(terminalText).not.toContain("stderr-secret");
	});

	it("redacts hidden interactive stderr before writing the debug log", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-hidden-stderr-"));
		tempDirs.push(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;

		takeOverInteractiveStderr();
		process.stderr.write(
			[
				"SECRET_TOKEN=debug-secret",
				"Authorization: Bearer stderr-secret",
				`token ${githubFineGrainedPat}`,
				"github_pat_short",
			].join("\n"),
		);
		restoreInteractiveStderr();

		const debugLogPath = getDebugLogPath();
		const log = readFileSync(debugLogPath, "utf8");
		expect(log).toContain("SECRET_TOKEN=[REDACTED]");
		expect(log).toContain("Authorization: Bearer [REDACTED]");
		expect(log).toContain("token [REDACTED]");
		expect(log).toContain("github_pat_short");
		expect(log).not.toContain("debug-secret");
		expect(log).not.toContain("stderr-secret");
		expect(log).not.toContain(githubFineGrainedPat);
		expect((statSync(debugLogPath).mode & 0o777).toString(8)).toBe("600");
	});
});
