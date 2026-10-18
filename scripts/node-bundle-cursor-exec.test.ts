import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repo = resolve(import.meta.dir, "..");
const bundle = join(repo, "packages/coding-agent/dist/bundle");
const cli = join(bundle, "cli.js");
const runtimes = ["node", "bun"] as const;

/**
 * A provider that behaves like Cursor's exec channel: on its first turn it runs the tool itself
 * (one ledger line), then hands the loop the tool call through the bundle's own
 * `chunks/cursor-agent.js`, which files the block as already executed. The loop must not run it
 * again, so the ledger ends with exactly that one line.
 */
function extensionSource(cursorAgentUrl: string): string {
	return `import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { synthesizeCursorExecToolCall } from ${JSON.stringify(cursorAgentUrl)};

const ledger = process.env.BUNDLE_EXEC_LEDGER;
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export default function cursorExecExtension(pi) {
	pi.registerTool({
		name: "record_execution",
		label: "record_execution",
		description: "Appends one line per execution",
		parameters: Type.Object({}),
		execute: async () => {
			appendFileSync(ledger, "agent-loop\\n");
			return { content: [{ type: "text", text: "recorded" }], details: {} };
		},
	});
	let turns = 0;
	pi.registerProvider("bundle-cursor", {
		baseUrl: "http://127.0.0.1:9",
		apiKey: "bundle-smoke",
		api: "bundle-cursor-exec",
		models: [{ id: "exec", name: "exec", reasoning: false, input: ["text"], cost: zero, contextWindow: 200000, maxTokens: 1024 }],
		streamSimple: (model) => {
			const stream = createAssistantMessageEventStream();
			const output = {
				role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
				usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } }, stopReason: "stop", timestamp: Date.now(),
			};
			queueMicrotask(() => {
				stream.push({ type: "start", partial: output });
				if (turns++ === 0) {
					appendFileSync(ledger, "exec-channel\\n");
					synthesizeCursorExecToolCall(output, stream, {}, "cursor-exec-1", "record_execution", {});
				} else {
					output.content.push({ type: "text", text: "done" });
				}
				stream.push({ type: "done", reason: "stop", message: output });
				stream.end();
			});
			return stream;
		},
	});
}
`;
}

beforeAll(() => {
	const result = spawnSync("node", ["scripts/build-coding-agent-bundle.mjs"], {
		cwd: repo, encoding: "utf8", timeout: 120_000,
	});
	expect(result.status, result.stderr).toBe(0);
}, 130_000);

describe.each(runtimes)("the Node bundle under %s", (runtime) => {
	// `chunks/cursor-agent.js` is emitted as a self-contained sibling with its own copy of the
	// block markers, while the agent loop lives in the main graph (#2334).
	test("runs a tool call Cursor's exec channel already executed exactly once", () => {
		// Given: isolated agent state and the exec-channel provider extension.
		const state = mkdtempSync(join(tmpdir(), "senpi-bundle-cursor-exec-"));
		mkdirSync(join(state, "home"));
		writeFileSync(join(state, "settings.json"), JSON.stringify({ disabledBuiltinExtensions: ["codemode"] }));
		const extension = join(state, "cursor-exec.ts");
		writeFileSync(extension, extensionSource(pathToFileURL(join(bundle, "chunks", "cursor-agent.js")).href));
		const ledger = join(state, "executions.log");
		writeFileSync(ledger, "");
		try {
			// When
			const result = spawnSync(
				runtime,
				[cli, "--extension", extension, "--model", "bundle-cursor/exec", "--no-session", "-p", "record it"],
				{
					cwd: state, encoding: "utf8", timeout: 60_000,
					env: {
						PATH: process.env.PATH ?? "", HOME: join(state, "home"), TMPDIR: state, TEMP: state, TMP: state,
						JITI_RESPECT_TMPDIR_ENV: "1",
						SENPI_CODING_AGENT_DIR: state, PI_OFFLINE: "1", BUNDLE_EXEC_LEDGER: ledger,
					},
				},
			);
			// Then: the exec channel's run is the only one.
			const output = `${result.stdout}${result.stderr}`;
			expect(result.status, output).toBe(0);
			expect(readFileSync(ledger, "utf8").split("\n").filter(Boolean), output).toEqual(["exec-channel"]);
		} finally {
			rmSync(state, { recursive: true, force: true });
		}
	}, 70_000);
});
