import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { registerTerminalExtension } from "../../../src/core/extensions/builtin/terminal/extension.ts";
import type { ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/types.ts";
import { initTheme, theme } from "../../../src/modes/interactive/theme/theme.ts";

// senpi#4104: `--print-prompt-sizes` is a one-shot inspection. Pointed at an existing session with a terminal
// manifest, its sizes-only startup must not take that session's terminal lease or restore (and possibly kill)
// the processes the manifest names; an ordinary startup still does.

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function generation(cwd: string, sessionId: string, sessionDir: string) {
	const handlers = new Map<string, Handler[]>();
	let activeTools: string[] = [];
	const pi = {
		registerTool: () => {},
		registerMessageRenderer: () => {},
		events: { emit: () => {} },
		on: (type: string, handler: Handler) => handlers.set(type, [...(handlers.get(type) ?? []), handler]),
		sendMessage: () => {},
		getActiveTools: () => activeTools,
		setActiveTools: (next: string[]) => {
			activeTools = next;
		},
		isLoopRemote: () => false,
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd,
		mode: "tui",
		model: { id: "test-model", api: "openai-completions" },
		ui: { setStatus: () => {}, notify: () => {}, theme },
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => join(sessionDir, `${sessionId}.jsonl`),
			getSessionDir: () => sessionDir,
		},
	} as unknown as ExtensionContext;
	registerTerminalExtension(pi);
	return async (type: string, payload: Record<string, unknown>) => {
		for (const handler of handlers.get(type) ?? []) await handler(payload, ctx);
	};
}

const savedForcePipe = process.env.SENPI_PTY_FORCE_PIPE;
const savedAgentDir = process.env.SENPI_CODING_AGENT_DIR;
let tmp: string;
let cwd: string;
let sessionDir: string;
let stateDir: string;
const sessionId = "inspected-session";
const manifest = JSON.stringify({ version: 1, monitors: [], backgrounds: [] });

beforeEach(() => {
	initTheme("dark");
	process.env.SENPI_PTY_FORCE_PIPE = "1";
	tmp = mkdtempSync(join(tmpdir(), "senpi-4104-"));
	process.env.SENPI_CODING_AGENT_DIR = join(tmp, "agent-home");
	cwd = join(tmp, "project");
	sessionDir = join(tmp, "sessions");
	stateDir = join(sessionDir, "extensions", "terminal");
	mkdirSync(join(cwd, ".senpi"), { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(join(stateDir, `${sessionId}.json`), manifest);
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	if (savedForcePipe === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
	else process.env.SENPI_PTY_FORCE_PIPE = savedForcePipe;
	if (savedAgentDir === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
	else process.env.SENPI_CODING_AGENT_DIR = savedAgentDir;
});

it("a sizes-only startup leaves an existing session's terminal lease and manifest alone", async () => {
	const emit = generation(cwd, sessionId, sessionDir);
	await emit("session_start", { type: "session_start", reason: "resume", sizesOnly: true });

	expect(existsSync(join(stateDir, `${sessionId}.lease`))).toBe(false);
	expect(readFileSync(join(stateDir, `${sessionId}.json`), "utf8")).toBe(manifest);
	await emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
});

it("an ordinary startup of the same session still takes the lease to restore its terminals", async () => {
	const emit = generation(cwd, sessionId, sessionDir);
	await emit("session_start", { type: "session_start", reason: "resume" });

	expect(existsSync(join(stateDir, `${sessionId}.lease`))).toBe(true);
	await emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
});
