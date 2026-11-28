import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Message,
	Model,
	Tool,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { decidePermissionOutcome } from "../../src/core/extensions/builtin/antigravity-acp/acp-client.ts";
import { createAntigravityAuthConfig } from "../../src/core/extensions/builtin/antigravity-acp/auth.ts";
import {
	AVAILABILITY_CACHE_TTL_MS,
	createAgyAuthStatusReader,
	probeAgyAuthStatus,
} from "../../src/core/extensions/builtin/antigravity-acp/availability.ts";
import { stopBridgeServer } from "../../src/core/extensions/builtin/antigravity-acp/bridge-server.ts";
import {
	ACP_CLIENT_INFO,
	BRIDGE_TOOL_PREFIX,
	SENTINEL_API_KEY,
} from "../../src/core/extensions/builtin/antigravity-acp/constants.ts";
import { agyChildEnvironment } from "../../src/core/extensions/builtin/antigravity-acp/environment.ts";
import { collectToolSearchMatchesForAntigravity } from "../../src/core/extensions/builtin/antigravity-acp/index.ts";
import {
	parseAgyAcpModels,
	resolveAgyModelTarget,
	STATIC_AGY_MODELS,
	toProviderModels,
} from "../../src/core/extensions/builtin/antigravity-acp/models.ts";
import {
	renderBootstrapBlocks,
	renderLateToolResultBlocks,
	renderMessagesAsText,
	renderUserTurnBlocks,
} from "../../src/core/extensions/builtin/antigravity-acp/prompt.ts";
import {
	closeAllSessions,
	getSession,
	messagePrefixDigest,
} from "../../src/core/extensions/builtin/antigravity-acp/session.ts";
import {
	loadAntigravityAcpSettingsFromDisk,
	parseAntigravityAcpSettings,
} from "../../src/core/extensions/builtin/antigravity-acp/settings.ts";
import {
	bridgeTools,
	createAntigravityStream,
	MAX_BRIDGE_TOOLS_BYTES,
} from "../../src/core/extensions/builtin/antigravity-acp/stream.ts";
import { hashTools, pruneStaleSessionWorkspaces } from "../../src/core/extensions/builtin/antigravity-acp/workspace.ts";

const FAKE_ACP_SOURCE = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const stateDir = process.cwd();
const logFile = process.env.FAKE_ACP_LOG || join(stateDir, "fake-acp-rpc.jsonl");
const log = (entry) => {
  if (args[0] === "acp" && !args.includes("--help")) {
    appendFileSync(logFile, JSON.stringify(entry) + "\\n");
  }
};

log({ argv: args, envKeys: Object.keys(process.env).sort(), noProxy: process.env.NO_PROXY });

if (args[0] === "acp" && args.includes("--help")) {
  process.stdout.write("Usage: agy acp\\n");
  process.exit(0);
}
if (args[0] === "models") {
  process.stdout.write("gemini-4-neon-xhigh\\tGemini 4 Neon (XHigh)\\ngemini-3.8-flash-low\\tGemini 3.8 Flash (Low)\\n");
  process.exit(0);
}

let activeSessionId = undefined;
let activeMcpUrl = undefined;
let activeMcpAuth = undefined;
let activeSystemAppend = "";
let activeModel = "gemini-4-neon";
let activeThought = "high";
const cancelledPrompts = new Set();

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const sendUpdate = (sessionId, update) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });

async function mcpPost(method, params = {}) {
  const res = await fetch(activeMcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: activeMcpAuth },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

let nextServerReq = 1;
const pendingServerReplies = new Map();
function askPermission(toolCall) {
  const id = "srv-" + (nextServerReq++);
  return new Promise((resolve) => {
    pendingServerReplies.set(id, resolve);
    send({
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: {
        sessionId: activeSessionId,
        toolCall,
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      },
    });
  });
}

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if ("id" in msg && !("method" in msg)) {
      const r = pendingServerReplies.get(msg.id);
      if (r) { pendingServerReplies.delete(msg.id); r(msg.result); }
      continue;
    }
    void handle(msg);
  }
});

async function handle(msg) {
  const { id, method, params = {} } = msg;
  log({ method, params });

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "Antigravity ACP Server", version: "1.5.14" },
        authMethods: [{ id: "gemini-api-key" }, { id: "agent-platform" }],
      },
    });
    return;
  }

  if (method === "authenticate") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  if (method === "session/new" || method === "session/resume") {
    const sid = method === "session/resume" ? params.sessionId : "conv-" + Math.random().toString(16).slice(2, 10);
    const convFile = join(stateDir, ".conv-" + sid + ".json");
    if (method === "session/resume" && !existsSync(convFile)) {
      send({ jsonrpc: "2.0", id, error: { code: -32603, message: "Missing session " + sid } });
      return;
    }
    activeSessionId = sid;
    const mcp = (params.mcpServers || [])[0];
    activeMcpUrl = mcp?.url;
    activeMcpAuth = mcp?.headers?.find(h => h.name === "Authorization")?.value || "";
    activeSystemAppend = params._meta?.antigravity?.systemPrompt?.append || "";
    if (!existsSync(convFile)) writeFileSync(convFile, JSON.stringify({ history: [] }));
    send({
      jsonrpc: "2.0",
      id,
      result: {
        sessionId: sid,
        models: {
          availableModels: [
            { modelId: "gemini-4-neon-xhigh", name: "Gemini 4 Neon (XHigh)" },
            { modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
            { modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
            { modelId: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)" },
            { modelId: "claude-opus-5-5-medium", name: "Claude Opus 5.5 (Medium)" },
          ],
          currentModelId: "gemini-4-neon-high",
        },
        configOptions: [
          {
            id: "model",
            category: "model",
            currentValue: "gemini-4-neon",
            options: [
              { value: "gemini-4-neon", name: "Gemini 4 Neon" },
              { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
              { value: "claude-opus-5-5", name: "Claude Opus 5.5" },
            ],
          },
          {
            id: "thought_level",
            category: "thought_level",
            currentValue: "high",
            options: [
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
              { value: "high", name: "High" },
              { value: "xhigh", name: "Extra" },
            ],
          },
        ],
      },
    });
    return;
  }

  if (method === "session/set_config_option") {
    if (params.configId === "model") activeModel = params.value;
    if (params.configId === "thought_level") activeThought = params.value;
    send({
      jsonrpc: "2.0",
      id,
      result: {
        configOptions: [
          { id: "model", category: "model", currentValue: activeModel, options: [{ value: "gemini-4-neon" }, { value: "gemini-3.8-flash" }, { value: "claude-opus-5-5" }] },
          { id: "thought_level", category: "thought_level", currentValue: activeThought, options: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }] },
        ],
      },
    });
    return;
  }

  if (method === "session/close") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  if (method === "session/cancel") {
    cancelledPrompts.add(params.sessionId);
    return;
  }

  if (method === "session/prompt") {
    const sid = params.sessionId;
    cancelledPrompts.delete(sid);
    const convFile = join(stateDir, ".conv-" + sid + ".json");
    const conv = existsSync(convFile) ? JSON.parse(readFileSync(convFile, "utf8")) : { history: [] };
    const textJoined = (params.prompt || []).filter(b => b.type === "text").map(b => b.text).join("\\n");
    const images = (params.prompt || []).filter(b => b.type === "image");
    conv.history.push(textJoined);
    writeFileSync(convFile, JSON.stringify(conv));

    if (textJoined.includes("TRIGGER_QUOTA_NOTICE")) {
      sendUpdate(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "⚠ API error (attempt 1): RESOURCE_EXHAUSTED (code 429): quota exceeded\\n" } });
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
      return;
    }

    if (textJoined.includes("TEST_PERMISSION")) {
      const deniedRes = await askPermission({ name: "run_command", title: "Run command" });
      const allowedRes = await askPermission({ name: "mcp_senpi-host_read", title: "Run mcp_senpi-host_read" });
      sendUpdate(sid, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "PERMS:" + deniedRes.outcome.optionId + ":" + allowedRes.outcome.optionId },
      });
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, thoughtTokens: 1 } } });
      return;
    }

    if (textJoined.includes("CALL_MCP_PARALLEL")) {
      const listRes = await mcpPost("tools/list");
      const [resA, resB] = await Promise.all([
        mcpPost("tools/call", { name: "read", arguments: { path: "a.txt" } }),
        mcpPost("tools/call", { name: "grep", arguments: { pattern: "hi" } }),
      ]);
      const outA = (resA.result?.content || []).map(c => c.text).join("");
      const outB = (resB.result?.content || []).map(c => c.text).join("");
      sendUpdate(sid, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "PARALLEL_OUT=" + outA + "+" + outB + "|TOOLS=" + listRes.result.tools.length },
      });
      send({
        jsonrpc: "2.0",
        id,
        result: { stopReason: "end_turn", usage: { inputTokens: 15, outputTokens: 8 } },
      });
      return;
    }

    if (textJoined.includes("CALL_MCP:")) {
      const m = /CALL_MCP:([^:\\s]+):(\\{[^\\n]*\\})/.exec(textJoined);
      const toolName = m[1];
      const toolArgs = JSON.parse(m[2]);
      const listRes = await mcpPost("tools/list");
      const perm = await askPermission({ name: "mcp_senpi-host_" + toolName, title: "Run mcp_senpi-host_" + toolName });
      if (perm.outcome.optionId !== "allow") {
        send({ jsonrpc: "2.0", id, error: { code: -32001, message: "Denied" } });
        return;
      }
      sendUpdate(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Planning tool call" } });
      const callPromise = mcpPost("tools/call", { name: toolName, arguments: toolArgs });
      const checkCancel = setInterval(() => {
        if (cancelledPrompts.has(sid)) {
          clearInterval(checkCancel);
          send({ jsonrpc: "2.0", id, result: { stopReason: "cancelled", usage: { inputTokens: 5, outputTokens: 2 } } });
        }
      }, 10);
      const mcpResult = await callPromise;
      clearInterval(checkCancel);
      if (cancelledPrompts.has(sid)) return;
      const toolText = (mcpResult.result?.content || []).map(c => c.text).join("");
      sendUpdate(sid, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "TOOLS=" + listRes.result.tools.length + "|TOOL_OUT=" + toolText },
      });
      send({
        jsonrpc: "2.0",
        id,
        result: { stopReason: "end_turn", usage: { inputTokens: 25, outputTokens: 12, cachedReadTokens: 5, thoughtTokens: 4 } },
      });
      return;
    }

    if (textJoined.includes("Results for your earlier host tool call")) {
      const listRes = activeMcpUrl ? await mcpPost("tools/list") : { result: { tools: [] } };
      const toolNames = (listRes.result?.tools || []).map(t => t.name).join(",");
      const discoveredName = /- mcp_senpi-host_(\\S+) —/.exec(textJoined)?.[1];
      const called = discoveredName && listRes.result?.tools.some(t => t.name === discoveredName)
        ? await mcpPost("tools/call", { name: discoveredName, arguments: {} })
        : undefined;
      const receipt = called?.result?.content?.map(c => c.text).join("") ?? "";
      sendUpdate(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "LATE_RECEIVED:" + toolNames + ":" + receipt + ":" + textJoined.slice(-120) } });
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: { inputTokens: 15, outputTokens: 8 } } });
      return;
    }

    if (textJoined.includes("EMIT_FAILED_TOOL_CALL")) {
      sendUpdate(sid, { sessionUpdate: "tool_call", toolCallId: "tc-fail", name: "mcp_superhuman_list_accounts", status: "failed" });
      sendUpdate(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "SURVIVED_FAILED_CALL" } });
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } } });
      return;
    }

    if (textJoined.includes("EMIT_BUILTIN_TOOL_CALL")) {
      sendUpdate(sid, { sessionUpdate: "tool_call", toolCallId: "tc-builtin", name: "run_command", status: "in_progress" });
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } } });
      return;
    }

    if (textJoined.includes("RECALL_HISTORY")) {
      sendUpdate(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "HIST:" + conv.history.join("||") } });
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: { inputTokens: 12, outputTokens: 6 } } });
      return;
    }

    sendUpdate(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking about " + activeModel + "/" + activeThought } });
    sendUpdate(sid, {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "MODEL=" + activeModel + "|THOUGHT=" + activeThought + "|IMAGES=" + images.length + "|SYS=" + activeSystemAppend.slice(0, 40) + "|MSG=" + textJoined,
      },
    });
    send({
      jsonrpc: "2.0",
      id,
      result: {
        stopReason: "end_turn",
        usage: { inputTokens: 20, outputTokens: 10, cachedReadTokens: 3, cachedWriteTokens: 1, thoughtTokens: 4, totalTokens: 34 },
      },
    });
  }
}
`;

const roots: string[] = [];
function makeTmpDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

const testModel: Model<Api> = {
	id: "gemini-4-neon",
	name: "Gemini 4 Neon via Antigravity",
	api: "antigravity-acp",
	provider: "antigravity-acp",
	baseUrl: "antigravity-acp",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_048_576,
	maxTokens: 65_536,
};

async function collectStream(
	stream: AsyncIterable<AssistantMessageEvent>,
): Promise<{ events: AssistantMessageEvent[]; final: AssistantMessage }> {
	const events: AssistantMessageEvent[] = [];
	let final: AssistantMessage | undefined;
	for await (const ev of stream) {
		events.push(ev);
		if (ev.type === "done") final = ev.message;
		if (ev.type === "error") final = ev.error;
	}
	if (!final) throw new Error("stream finished without terminal event");
	return { events, final };
}

function makeFakeBinary(dir: string): string {
	const binPath = join(dir, "fake-agy.mjs");
	const source = FAKE_ACP_SOURCE.replace("#!/usr/bin/env node", `#!${process.execPath}`);
	writeFileSync(binPath, source, "utf8");
	chmodSync(binPath, 0o755);
	return binPath;
}

function readLog(logPath: string): Array<Record<string, unknown>> {
	if (!existsSync(logPath)) return [];
	return readFileSync(logPath, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

function readWorkspaceLogs(agentDir: string): Array<Record<string, unknown>> {
	const wsRoot = join(agentDir, "antigravity-acp/workspaces");
	if (!existsSync(wsRoot)) return [];
	const rows: Array<Record<string, unknown>> = [];
	for (const file of readDirFiles(wsRoot)) {
		if (file.endsWith("fake-acp-rpc.jsonl")) rows.push(...readLog(file));
	}
	return rows;
}

afterEach(async () => {
	await closeAllSessions();
	await stopBridgeServer();
	delete process.env.FAKE_ACP_LOG;
	for (const dir of roots.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("antigravity-acp ACP modules", () => {
	test("environment merges NO_PROXY/no_proxy loopback hosts, strips SSH_*, adds Linux DBus fallback, and isolates auth env vars", () => {
		const baseEnv = agyChildEnvironment(
			{
				HOME: "/tmp/h",
				PATH: "/usr/bin",
				NO_PROXY: "corp.internal,127.0.0.1",
				no_proxy: "other.internal",
				SSH_CONNECTION: "1.2.3.4 12345 5.6.7.8 22",
				SSH_CLIENT: "1.2.3.4 12345 22",
				SSH_TTY: "/dev/pts/0",
				GEMINI_API_KEY: "secret-key",
				GOOGLE_CLOUD_PROJECT: "my-proj",
			},
			{ platform: "darwin" },
		);
		expect(baseEnv.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("1");
		expect(baseEnv.NO_PROXY).toBe("corp.internal,127.0.0.1,other.internal,localhost,::1");
		expect(baseEnv.no_proxy).toBe(baseEnv.NO_PROXY);
		expect(baseEnv.SSH_CONNECTION).toBeUndefined();
		expect(baseEnv.SSH_CLIENT).toBeUndefined();
		expect(baseEnv.SSH_TTY).toBeUndefined();
		expect(baseEnv.XDG_RUNTIME_DIR).toBeUndefined();
		expect(baseEnv.DBUS_SESSION_BUS_ADDRESS).toBeUndefined();
		expect(baseEnv.GEMINI_API_KEY).toBeUndefined();
		expect(baseEnv.GOOGLE_CLOUD_PROJECT).toBeUndefined();

		const linuxWithBus = agyChildEnvironment(
			{ HOME: "/home/au", SSH_CONNECTION: "x", SSH_CLIENT: "y", SSH_TTY: "z" },
			{
				platform: "linux",
				uid: 1000,
				pathExists: (p) => p === "/run/user/1000" || p === "/run/user/1000/bus",
			},
		);
		expect(linuxWithBus.SSH_CONNECTION).toBeUndefined();
		expect(linuxWithBus.XDG_RUNTIME_DIR).toBe("/run/user/1000");
		expect(linuxWithBus.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/run/user/1000/bus");

		const linuxWithoutBus = agyChildEnvironment(
			{ HOME: "/home/au" },
			{ platform: "linux", uid: 1000, pathExists: () => false },
		);
		expect(linuxWithoutBus.XDG_RUNTIME_DIR).toBeUndefined();
		expect(linuxWithoutBus.DBUS_SESSION_BUS_ADDRESS).toBeUndefined();

		const apiKeyEnv = agyChildEnvironment(
			{ HOME: "/tmp/h", GEMINI_API_KEY: "secret-key", GOOGLE_CLOUD_PROJECT: "my-proj" },
			{ authMethod: "gemini-api-key" },
		);
		expect(apiKeyEnv.GEMINI_API_KEY).toBe("secret-key");
		expect(apiKeyEnv.GOOGLE_CLOUD_PROJECT).toBeUndefined();

		const vertexEnv = agyChildEnvironment(
			{
				HOME: "/tmp/h",
				GEMINI_API_KEY: "secret-key",
				GOOGLE_CLOUD_PROJECT: "my-proj",
				GOOGLE_CLOUD_LOCATION: "us-central1",
			},
			{ authMethod: "agent-platform" },
		);
		expect(vertexEnv.GEMINI_API_KEY).toBeUndefined();
		expect(vertexEnv.GOOGLE_CLOUD_PROJECT).toBe("my-proj");
		expect(vertexEnv.GOOGLE_CLOUD_LOCATION).toBe("us-central1");
	});

	test("models advertise image input, parse ACP catalogs, and clamp thinking tiers per family", () => {
		const providerModels = toProviderModels(STATIC_AGY_MODELS);
		expect(providerModels.length).toBeGreaterThan(0);
		expect(providerModels.every((m) => m.input.includes("image"))).toBe(true);

		const parsed = parseAgyAcpModels(
			[
				{ modelId: "gemini-4-neon-xhigh", name: "Gemini 4 Neon (XHigh)" },
				{ modelId: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)" },
			],
			undefined,
		);
		expect(parsed).toHaveLength(2);

		const neonTarget = resolveAgyModelTarget("gemini-4-neon", "xhigh", {
			advertisedConfigModels: ["gemini-4-neon", "claude-opus-5-5"],
			advertisedThoughtLevels: ["low", "medium", "high", "xhigh"],
		});
		expect(neonTarget).toEqual({
			agyModelId: "gemini-4-neon-xhigh",
			thinkingTier: "xhigh",
			configModelId: "gemini-4-neon",
			thoughtLevel: "xhigh",
		});

		const opusTarget = resolveAgyModelTarget("claude-opus-5-5", "xhigh", {
			advertisedConfigModels: ["gemini-4-neon", "claude-opus-5-5"],
			advertisedThoughtLevels: ["low", "medium", "high", "xhigh"],
		});
		expect(opusTarget).toEqual({
			agyModelId: "claude-opus-5-5-high",
			thinkingTier: "high",
			configModelId: "claude-opus-5-5",
			thoughtLevel: "high",
		});

		const concreteTarget = resolveAgyModelTarget("gemini-4-neon-medium", undefined, {
			advertisedConfigModels: ["gemini-4-neon"],
			advertisedThoughtLevels: ["low", "medium", "high", "xhigh"],
		});
		expect(concreteTarget).toEqual({
			agyModelId: "gemini-4-neon-medium",
			thinkingTier: "medium",
			configModelId: "gemini-4-neon",
			thoughtLevel: "medium",
		});
	});

	test("prompt preserves native image blocks and differentiates image digests", () => {
		const m1: Message = {
			role: "user",
			content: [
				{ type: "text", text: "Look at this:" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
			],
			timestamp: 1,
		};
		const m2: Message = {
			role: "user",
			content: [
				{ type: "text", text: "Look at this:" },
				{ type: "image", data: "BBBB", mimeType: "image/png" },
			],
			timestamp: 2,
		};
		expect(renderUserTurnBlocks([m1])).toEqual([
			{ type: "text", text: "Look at this:" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		]);
		expect(renderMessagesAsText([m1])).not.toBe(renderMessagesAsText([m2]));
		expect(messagePrefixDigest([m1])).not.toBe(messagePrefixDigest([m2]));

		const boot = renderBootstrapBlocks([{ role: "user", content: "earlier", timestamp: 1 }], [m1]);
		expect(boot[0]?.type).toBe("text");
		expect(boot[1]).toEqual({ type: "image", data: "AAAA", mimeType: "image/png" });

		const late = renderLateToolResultBlocks(
			[
				{
					role: "toolResult",
					toolCallId: "agy_1",
					toolName: "read",
					isError: false,
					content: [{ type: "text", text: "file body" }],
					timestamp: 3,
				},
			],
			[{ role: "user", content: "hurry", timestamp: 4 }],
		);
		expect(late[0]?.type).toBe("text");
		if (late[0]?.type === "text") {
			expect(late[0].text).toContain("file body");
			expect(late[0].text).toContain("hurry");
		}
	});

	test("permission helper approves only bridge tools and rejects builtins", () => {
		const allow = decidePermissionOutcome({
			toolCall: { name: "mcp_senpi-host_bash", title: "Run mcp_senpi-host_bash" },
			options: [
				{ optionId: "allow", kind: "allow_once" },
				{ optionId: "deny", kind: "reject_once" },
			],
		});
		expect(allow).toEqual({
			allowed: true,
			toolName: "mcp_senpi-host_bash",
			response: { outcome: { outcome: "selected", optionId: "allow" } },
		});

		const deny = decidePermissionOutcome({
			toolCall: { name: "run_command", title: "Run command" },
			options: [
				{ optionId: "allow", kind: "allow_once" },
				{ optionId: "deny", kind: "reject_once" },
			],
		});
		expect(deny).toEqual({
			allowed: false,
			toolName: "run_command",
			response: { outcome: { outcome: "selected", optionId: "deny" } },
		});
	});

	test("availability and auth config work without global settings mutation", async () => {
		const tmp = makeTmpDir("agy-avail-");
		const bin = makeFakeBinary(tmp);
		expect(
			await probeAgyAuthStatus({
				resolveExecutable: () => bin,
				settings: { authMethod: "gemini-api-key" },
				parentEnv: { HOME: tmp, PATH: process.env.PATH, GEMINI_API_KEY: "gem-key" },
			}),
		).toBe(true);
		expect(
			await probeAgyAuthStatus({
				resolveExecutable: () => bin,
				settings: { authMethod: "gemini-api-key" },
				parentEnv: { HOME: tmp, PATH: process.env.PATH },
			}),
		).toBe(false);

		const auth = createAntigravityAuthConfig({
			readSettings: () => ({ enabled: true }),
			readAuthStatus: async () => true,
			resolveExecutable: () => bin,
			readStoredCredential: async () => undefined,
		});
		const cred = await auth.login({
			onAuth: () => {},
			onDeviceCode: () => {},
			onPrompt: async () => "",
			onSelect: async () => undefined,
		});
		expect(cred.access).toBe(SENTINEL_API_KEY);
	});

	test("availability disk cache skips spawning until forced, mtime changes, or TTL expires", async () => {
		const tmp = makeTmpDir("agy-cache-");
		const probeLog = join(tmp, "probes.log");
		const bin = join(tmp, "probe-agy.mjs");
		writeFileSync(
			bin,
			[
				`#!${process.execPath}`,
				`import { appendFileSync } from "node:fs";`,
				`const args = process.argv.slice(2);`,
				`appendFileSync(${JSON.stringify(probeLog)}, JSON.stringify(args) + "\\n");`,
				`if (args[0] === "acp" && args.includes("--help")) process.exit(0);`,
				`process.exit(1);`,
			].join("\n"),
			"utf8",
		);
		chmodSync(bin, 0o755);

		const cachePath = join(tmp, "cache", "availability.json");
		const readInvocations = () =>
			existsSync(probeLog) ? readFileSync(probeLog, "utf8").trim().split("\n").filter(Boolean).length : 0;

		let nowMs = 1_700_000_000_000;
		const commonOpts = {
			resolveExecutable: () => bin,
			parentEnv: { HOME: tmp, PATH: process.env.PATH, GEMINI_API_KEY: "gem-key" },
			cachePath,
			now: () => nowMs,
		};

		expect(await probeAgyAuthStatus(commonOpts)).toBe(true);
		expect(readInvocations()).toBe(1); // acp --help
		expect(existsSync(cachePath)).toBe(true);

		// Second call hits disk cache: 0 new spawns.
		expect(await probeAgyAuthStatus(commonOpts)).toBe(true);
		expect(readInvocations()).toBe(1);

		// force: true bypasses disk cache and re-runs probe.
		expect(await probeAgyAuthStatus({ ...commonOpts, force: true })).toBe(true);
		expect(readInvocations()).toBe(2);

		// auth.login bypasses both in-memory and disk caches via { force: true }.
		const reader = createAgyAuthStatusReader((opts) => probeAgyAuthStatus({ ...commonOpts, force: opts?.force }));
		expect(await reader()).toBe(true);
		expect(readInvocations()).toBe(2);
		const auth = createAntigravityAuthConfig({
			readSettings: () => ({ enabled: true }),
			readAuthStatus: reader,
			resolveExecutable: () => bin,
			readStoredCredential: async () => undefined,
		});
		await auth.login({
			onAuth: () => {},
			onDeviceCode: () => {},
			onPrompt: async () => "",
			onSelect: async () => undefined,
		});
		expect(readInvocations()).toBe(3);

		// Changing executable mtime invalidates disk cache.
		const future = new Date(Date.now() + 60_000);
		utimesSync(bin, future, future);
		expect(await probeAgyAuthStatus(commonOpts)).toBe(true);
		expect(readInvocations()).toBe(4);

		// Advancing clock past AVAILABILITY_CACHE_TTL_MS invalidates disk cache.
		nowMs += AVAILABILITY_CACHE_TTL_MS + 1;
		expect(await probeAgyAuthStatus(commonOpts)).toBe(true);
		expect(readInvocations()).toBe(5);
	});

	test("default, gemini-api-key, agent-platform, and unknown auth methods fail closed without spawning", async () => {
		const tmp = makeTmpDir("agy-fastfail-");
		const probeLog = join(tmp, "probes.log");
		const bin = join(tmp, "fastfail-agy.mjs");
		writeFileSync(
			bin,
			[
				`#!${process.execPath}`,
				`import { appendFileSync } from "node:fs";`,
				`appendFileSync(${JSON.stringify(probeLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
				`process.exit(0);`,
			].join("\n"),
			"utf8",
		);
		chmodSync(bin, 0o755);

		expect(
			await probeAgyAuthStatus({
				resolveExecutable: () => bin,
				settings: {},
				parentEnv: { HOME: tmp, PATH: process.env.PATH },
			}),
		).toBe(false);
		expect(
			await probeAgyAuthStatus({
				resolveExecutable: () => bin,
				settings: { authMethod: "gemini-api-key" },
				parentEnv: { HOME: tmp, PATH: process.env.PATH },
			}),
		).toBe(false);
		expect(
			await probeAgyAuthStatus({
				resolveExecutable: () => bin,
				settings: { authMethod: "agent-platform" },
				parentEnv: { HOME: tmp, PATH: process.env.PATH },
			}),
		).toBe(false);
		expect(
			await probeAgyAuthStatus({
				resolveExecutable: () => bin,
				settings: { authMethod: "unsupported-method" as never },
				parentEnv: { HOME: tmp, PATH: process.env.PATH, GEMINI_API_KEY: "gem-key" },
			}),
		).toBe(false);
		expect(existsSync(probeLog)).toBe(false);

		expect(parseAntigravityAcpSettings({ authMethod: "gemini-api-key" }).authMethod).toBe("gemini-api-key");
		expect(parseAntigravityAcpSettings({ authMethod: "agent-platform" }).authMethod).toBe("agent-platform");
		expect(parseAntigravityAcpSettings({ authMethod: "unsupported-method" }).authMethod).toBeUndefined();
	});

	test("settings ignore untrusted project configs and honor only global agent settings and env overrides", () => {
		const root = makeTmpDir("agy-settings-");
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".senpi"), { recursive: true });
		mkdirSync(join(projectDir, ".omo"), { recursive: true });

		writeFileSync(
			join(projectDir, ".senpi", "settings.json"),
			JSON.stringify({
				antigravityAcpProvider: {
					enabled: true,
					executablePath: join(projectDir, "evil-agy"),
					authMethod: "agent-platform",
				},
			}),
			"utf8",
		);
		writeFileSync(
			join(projectDir, ".omo", "settings.json"),
			JSON.stringify({
				antigravityAcpProvider: {
					enabled: true,
					executablePath: join(projectDir, "evil-omo-agy"),
				},
			}),
			"utf8",
		);

		expect(loadAntigravityAcpSettingsFromDisk(projectDir, agentDir, {})).toEqual({});

		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				antigravityAcpProvider: {
					enabled: true,
					executablePath: "/usr/local/bin/agy",
					authMethod: "agent-platform",
					resumeMode: "off",
				},
			}),
			"utf8",
		);
		expect(loadAntigravityAcpSettingsFromDisk(projectDir, agentDir, {})).toEqual({
			enabled: true,
			executablePath: "/usr/local/bin/agy",
			authMethod: "agent-platform",
			resumeMode: "off",
		});

		expect(
			loadAntigravityAcpSettingsFromDisk(projectDir, agentDir, {
				SENPI_ANTIGRAVITY_ACP_ENABLED: "false",
				SENPI_ANTIGRAVITY_ACP_AUTH_METHOD: "gemini-api-key",
				SENPI_ANTIGRAVITY_ACP_RESUME: "auto",
			}),
		).toEqual({
			enabled: false,
			executablePath: "/usr/local/bin/agy",
			authMethod: "gemini-api-key",
			resumeMode: "auto",
		});
	});
});

describe("antigravity-acp ACP end-to-end stream", () => {
	let tmp: string;
	let agentDir: string;
	let projectDir: string;
	let logPath: string;
	let binPath: string;
	let bindings: Array<{ key: string; conversationId: string }>;

	beforeEach(() => {
		tmp = makeTmpDir("agy-stream-");
		agentDir = join(tmp, "agent");
		projectDir = join(tmp, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		logPath = join(tmp, "acp.log.jsonl");
		process.env.FAKE_ACP_LOG = logPath;
		binPath = makeFakeBinary(tmp);
		bindings = [];
	});

	function makeStream(
		opts: Pick<
			Parameters<typeof createAntigravityStream>[0],
			"holdLimitMs" | "cancelTimeoutMs" | "toolBatchCoalesceMs" | "discoveredTools"
		> = {},
	) {
		return createAntigravityStream({
			getCwd: () => projectDir,
			resolveExecutable: () => binPath,
			loadSettings: () => ({ enabled: true, resumeMode: "auto" }),
			agentDir,
			acpArgs: ["acp", "--agent", "senpi-host"],
			holdLimitMs: opts.holdLimitMs,
			cancelTimeoutMs: opts.cancelTimeoutMs,
			toolBatchCoalesceMs: opts.toolBatchCoalesceMs,
			discoveredTools: opts.discoveredTools,
			onBinding: (key, binding) => bindings.push({ key, conversationId: binding.conversationId }),
		});
	}

	test("streams thinking + text + images + honest clientInfo + usage", async () => {
		const streamFn = makeStream();
		const ctx = {
			systemPrompt: "Be concise.",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Hello ACP" },
						{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
					],
					timestamp: 1,
				},
			],
			tools: [],
		};
		const { events, final } = await collectStream(
			streamFn(testModel, ctx as never, { sessionId: "s1", streamKind: "main", reasoning: "xhigh" }),
		);
		expect(final.stopReason).toBe("stop");
		expect(events.some((e) => e.type === "thinking_delta")).toBe(true);
		expect(events.some((e) => e.type === "text_delta")).toBe(true);
		const textBlock = final.content.find((b) => b.type === "text");
		expect(textBlock?.type === "text" ? textBlock.text : "").toContain("MODEL=gemini-4-neon|THOUGHT=xhigh|IMAGES=1");
		expect(final.usage).toMatchObject({
			input: 20,
			output: 10,
			cacheRead: 3,
			cacheWrite: 1,
			reasoning: 4,
			totalTokens: 34,
		});

		const rows = readWorkspaceLogs(agentDir);
		const initRow = rows.find((r) => r.method === "initialize");
		expect((initRow?.params as Record<string, unknown>)?.clientInfo).toEqual(ACP_CLIENT_INFO);
		const newSess = rows.find((r) => r.method === "session/new");
		const append = (
			(newSess?.params as Record<string, unknown>)?._meta as Record<string, Record<string, Record<string, string>>>
		)?.antigravity?.systemPrompt?.append;
		expect(append).toContain("Be concise.");
		expect(bindings).toHaveLength(1);
	});

	test("extracts system prompt and tools from normalized TranscriptContext", async () => {
		const streamFn = makeStream();
		const ctx = {
			messages: [
				{
					role: "system",
					content: "Normalized system instruction",
					tools: [],
					timestamp: 0,
				},
				{
					role: "user",
					content: [{ type: "text", text: "Hello normalized" }],
					timestamp: 1,
				},
			],
		};
		const { final } = await collectStream(
			streamFn(testModel, ctx as never, { sessionId: "s-norm", streamKind: "main" }),
		);
		expect(final.stopReason).toBe("stop");
		const rows = readWorkspaceLogs(agentDir);
		const newSess = rows.find((r) => r.method === "session/new");
		const append = (
			(newSess?.params as Record<string, unknown>)?._meta as Record<string, Record<string, Record<string, string>>>
		)?.antigravity?.systemPrompt?.append;
		expect(append).toContain("Normalized system instruction");
	});

	test("permission handler approves bridge tools and denies agy builtins", async () => {
		const streamFn = makeStream();
		const { final } = await collectStream(
			streamFn(
				testModel,
				{
					systemPrompt: "",
					messages: [{ role: "user", content: "TEST_PERMISSION", timestamp: 1 }],
					tools: [],
				} as never,
				{ sessionId: "s-perm", streamKind: "main" },
			),
		);
		const text = final.content.find((b) => b.type === "text");
		expect(text?.type === "text" ? text.text : "").toBe("PERMS:deny:allow");
	});

	test("parks HTTP MCP tool call across toolUse and resolves on next turn", async () => {
		const streamFn = makeStream();
		const tools: Tool[] = [
			{
				name: "read",
				description: "Read file",
				parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } as never,
			},
		];
		const userMsg: Message = { role: "user", content: 'CALL_MCP:read:{"path":"a.txt"}', timestamp: 1 };
		const turn1 = await collectStream(
			streamFn(testModel, { systemPrompt: "", messages: [userMsg], tools } as never, {
				sessionId: "s-tool",
				streamKind: "main",
			}),
		);
		expect(turn1.final.stopReason).toBe("toolUse");
		const call = turn1.final.content.find((b) => b.type === "toolCall");
		expect(call?.type).toBe("toolCall");
		if (call?.type !== "toolCall") throw new Error("missing toolCall");
		expect(call.name).toBe("read");
		expect(call.arguments).toEqual({ path: "a.txt" });

		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: call.id,
			toolName: "read",
			isError: false,
			content: [{ type: "text", text: "CONTENTS-OK" }],
			timestamp: 2,
		};
		const turn2 = await collectStream(
			streamFn(testModel, { systemPrompt: "", messages: [userMsg, turn1.final, toolResult], tools } as never, {
				sessionId: "s-tool",
				streamKind: "main",
			}),
		);
		expect(turn2.final.stopReason).toBe("stop");
		const text = turn2.final.content.find((b) => b.type === "text");
		expect(text?.type === "text" ? text.text : "").toBe("TOOLS=1|TOOL_OUT=CONTENTS-OK");
	});

	test("detaches slow parked MCP call after holdLimitMs and sends late toolResult in new prompt", async () => {
		const streamFn = makeStream({ holdLimitMs: 80, cancelTimeoutMs: 1_500 });
		const tools: Tool[] = [
			{
				name: "bash",
				description: "Run bash",
				parameters: { type: "object", properties: { cmd: { type: "string" } } } as never,
			},
		];
		const userMsg: Message = { role: "user", content: 'CALL_MCP:bash:{"cmd":"sleep 2"}', timestamp: 1 };
		const turn1 = await collectStream(
			streamFn(testModel, { systemPrompt: "", messages: [userMsg], tools } as never, {
				sessionId: "s-hold",
				streamKind: "main",
			}),
		);
		expect(turn1.final.stopReason).toBe("toolUse");
		const call = turn1.final.content.find((b) => b.type === "toolCall");
		if (call?.type !== "toolCall") throw new Error("missing toolCall");

		await vi.waitFor(() => {
			expect(getSession("s-hold")?.queue.hasDetached()).toBe(true);
		});

		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: call.id,
			toolName: "bash",
			isError: false,
			content: [{ type: "text", text: "SLOW-DONE-999" }],
			timestamp: 2,
		};
		const turn2 = await collectStream(
			streamFn(testModel, { systemPrompt: "", messages: [userMsg, turn1.final, toolResult], tools } as never, {
				sessionId: "s-hold",
				streamKind: "main",
			}),
		);
		expect(turn2.final.stopReason).toBe("stop");
		const text = turn2.final.content.find((b) => b.type === "text");
		expect(text?.type === "text" ? text.text : "").toContain("LATE_RECEIVED:");
		expect(text?.type === "text" ? text.text : "").toContain("SLOW-DONE-999");
	});

	test("intercepts agy quota retry notice and fails with 429 rate limit", async () => {
		const streamFn = makeStream();
		const { final } = await collectStream(
			streamFn(
				testModel,
				{
					systemPrompt: "",
					messages: [{ role: "user", content: "TRIGGER_QUOTA_NOTICE", timestamp: 1 }],
					tools: [],
				} as never,
				{ sessionId: "s-429", streamKind: "main" },
			),
		);
		expect(final.stopReason).toBe("error");
		expect(final.errorMessage).toContain("429 rate limit");
		expect(final.content.some((b) => b.type === "text" && b.text.includes("attempt 1"))).toBe(false);
	});

	test("resumes conversation across process restarts via session/resume and falls back to bootstrap if missing", async () => {
		const streamFn = makeStream();
		const m1: Message = { role: "user", content: "FIRST_TURN_TOKEN", timestamp: 1 };
		const t1 = await collectStream(
			streamFn(testModel, { systemPrompt: "", messages: [m1], tools: [] } as never, {
				sessionId: "s-res",
				streamKind: "main",
			}),
		);
		expect(t1.final.stopReason).toBe("stop");
		await closeAllSessions();

		const m2: Message = { role: "user", content: "RECALL_HISTORY", timestamp: 2 };
		const t2 = await collectStream(
			streamFn(testModel, { systemPrompt: "", messages: [m1, t1.final, m2], tools: [] } as never, {
				sessionId: "s-res",
				streamKind: "main",
			}),
		);
		expect(t2.final.stopReason).toBe("stop");
		const text2 = t2.final.content.find((b) => b.type === "text");
		expect(text2?.type === "text" ? text2.text : "").toContain("FIRST_TURN_TOKEN||RECALL_HISTORY");

		const rows = readWorkspaceLogs(agentDir);
		expect(rows.some((r) => r.method === "session/resume")).toBe(true);

		// Now wipe the fake server's saved conversation file and force process restart -> should fall back cleanly to session/new + bootstrap replay.
		await closeAllSessions();
		const wsRoot = join(agentDir, "antigravity-acp/workspaces");
		for (const sub of readDirFiles(wsRoot)) {
			if (sub.includes(".conv-")) rmSync(sub, { force: true });
		}
		const m3: Message = { role: "user", content: "AFTER_MISSING_RESUME", timestamp: 3 };
		const t3 = await collectStream(
			streamFn(testModel, { systemPrompt: "", messages: [m1, t1.final, m2, t2.final, m3], tools: [] } as never, {
				sessionId: "s-res",
				streamKind: "main",
			}),
		);
		expect(t3.final.stopReason).toBe("stop");
		const text3 = t3.final.content.find((b) => b.type === "text");
		expect(text3?.type === "text" ? text3.text : "").toContain("FIRST_TURN_TOKEN");
		expect(text3?.type === "text" ? text3.text : "").toContain("AFTER_MISSING_RESUME");
	});

	test("offers canonical bridge names without changing Senpi's active tool set", () => {
		const tool = {
			name: "mcp_superhuman_list_accounts",
			exposure: "direct" as const,
			allowLazyActivation: true,
			description: "List accounts",
			parameters: { type: "object", properties: {} } as Tool["parameters"],
		};
		const offered = new Set<string>();
		const pi = {
			getAllTools: () => [
				tool,
				{ ...tool, name: "hidden_tool", exposure: "hidden" as const },
				{ ...tool, name: "eval_only", exposure: "eval" as const },
				{ ...tool, name: "no_lazy", allowLazyActivation: false },
			],
		};
		const baseEvent = {
			toolName: "tool_search",
			isError: false,
			details: { matched: [tool.name, "hidden_tool", "eval_only", "no_lazy"] },
			content: [
				{
					type: "text" as const,
					text: "Found 4 tools. Nothing was activated; call one by name and it activates on that first call:\n\n- mcp_superhuman_list_accounts — List accounts\n- hidden_tool — Hidden\n- eval_only — Eval only\n- no_lazy — No lazy activation",
				},
			],
		};

		expect(
			collectToolSearchMatchesForAntigravity(pi, baseEvent, { model: { provider: "openai" } as never }, offered),
		).toBeUndefined();

		expect(
			collectToolSearchMatchesForAntigravity(
				pi,
				{ ...baseEvent, isError: true },
				{ model: { provider: "antigravity-acp" } as never },
				offered,
			),
		).toBeUndefined();

		const rewritten = collectToolSearchMatchesForAntigravity(
			pi,
			baseEvent,
			{
				model: { provider: "antigravity-acp" } as never,
			},
			offered,
		);
		expect([...offered]).toEqual([tool.name]);
		const text = rewritten?.content?.[0]?.type === "text" ? rewritten.content[0].text : "";
		expect(text).toContain(`- ${BRIDGE_TOOL_PREFIX}${tool.name}`);
		expect(text).not.toContain(`- ${tool.name}`);
		for (const name of ["hidden_tool", "eval_only", "no_lazy"]) expect(text).not.toContain(`- ${name}`);
	});

	test("refreshes agy's MCP inventory with discovered tools that remain inactive on Senpi", async () => {
		const discovered = new Map<string, Tool[]>();
		const streamFn = makeStream({ discoveredTools: (key) => discovered.get(key) ?? [] });
		const toolSearchTool: Tool = {
			name: "tool_search",
			description: "Search deferred tools",
			parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } as never,
		};
		const superhumanTool: Tool = {
			name: "mcp_superhuman_list_accounts",
			description: "List Superhuman accounts",
			parameters: { type: "object", properties: {} } as never,
		};
		const userMsg: Message = { role: "user", content: 'CALL_MCP:tool_search:{"query":"superhuman"}', timestamp: 1 };
		const turn1 = await collectStream(
			streamFn(testModel, { systemPrompt: "", messages: [userMsg], tools: [toolSearchTool] } as never, {
				sessionId: "s-refresh-tools",
				streamKind: "main",
			}),
		);
		expect(turn1.final.stopReason).toBe("toolUse");
		const call = turn1.final.content.find((b) => b.type === "toolCall");
		if (call?.type !== "toolCall") throw new Error("missing toolCall");

		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: call.id,
			toolName: "tool_search",
			isError: false,
			content: [{ type: "text", text: `- ${BRIDGE_TOOL_PREFIX}${superhumanTool.name} — List accounts` }],
			timestamp: 2,
		};
		discovered.set("s-refresh-tools", [superhumanTool]);
		const turn2 = await collectStream(
			streamFn(
				testModel,
				{
					systemPrompt: "",
					messages: [userMsg, turn1.final, toolResult],
					tools: [toolSearchTool],
				} as never,
				{ sessionId: "s-refresh-tools", streamKind: "main" },
			),
		);
		expect(turn2.final.stopReason).toBe("toolUse");
		const discoveredCall = turn2.final.content.find((block) => block.type === "toolCall");
		expect(discoveredCall).toMatchObject({ name: superhumanTool.name, arguments: {} });
		if (discoveredCall?.type !== "toolCall") throw new Error("missing discovered tool call");
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: discoveredCall.id,
			toolName: discoveredCall.name,
			isError: false,
			content: [{ type: "text", text: "fixture account list" }],
			timestamp: 3,
		};
		const turn3 = await collectStream(
			streamFn(
				testModel,
				{
					systemPrompt: "",
					messages: [userMsg, turn1.final, toolResult, turn2.final, result],
					tools: [toolSearchTool, superhumanTool],
				} as never,
				{ sessionId: "s-refresh-tools", streamKind: "main" },
			),
		);
		expect(turn3.final.stopReason).toBe("stop");
		expect(turn3.final.content).toContainEqual(
			expect.objectContaining({
				type: "text",
				text: expect.stringContaining(`LATE_RECEIVED:${superhumanTool.name},tool_search:fixture account list:`),
			}),
		);

		const rows = readWorkspaceLogs(agentDir);
		expect(rows.some((r) => r.method === "session/close")).toBe(true);
		expect(rows.some((r) => r.method === "session/resume")).toBe(true);
	});

	test("compacts schemas, collapses const unions, sorts canonically, and stays under byte budget", () => {
		const evalLikeTool: Tool = {
			name: "eval",
			description: "Run   eval\n\n  cell   ".repeat(40),
			parameters: {
				type: "object",
				properties: {
					action: {
						anyOf: [
							{ const: "run", description: "run cell" },
							{ const: "list", description: "list cells" },
						],
						description: "Action   to   perform",
					},
					language: {
						oneOf: [{ const: "js" }, { const: "py" }],
					},
					code: { type: "string", description: "Code body ".repeat(30) },
				},
				anyOf: [
					{
						type: "object",
						properties: { action: { const: "run" }, code: { type: "string" } },
						required: ["code"],
					},
					{ type: "object", properties: { action: { const: "list" } }, required: ["action"] },
				],
			} as never,
		};
		const readTool: Tool = {
			name: "read",
			description: "Read file",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } as never,
		};

		// Canonical sorting keeps hashTools identical when a tool moves from discovered to active.
		const whenDiscovered = bridgeTools([readTool], [evalLikeTool]);
		const whenActivated = bridgeTools([readTool, evalLikeTool], []);
		expect(whenDiscovered.map((t) => t.name)).toEqual(["eval", "read"]);
		expect(hashTools(whenDiscovered)).toBe(hashTools(whenActivated));

		const compactedEval = whenDiscovered.find((t) => t.name === "eval");
		expect(compactedEval).toBeDefined();
		if (!compactedEval) throw new Error("expected eval tool");
		expect(compactedEval.description.length).toBeLessThanOrEqual(240);
		expect(compactedEval.inputSchema.anyOf).toBeUndefined();
		const props = compactedEval.inputSchema.properties as Record<string, Record<string, unknown>>;
		expect(props.action).toEqual({
			type: "string",
			enum: ["run", "list"],
			description: "Action to perform",
		});
		expect(props.language).toEqual({
			type: "string",
			enum: ["js", "py"],
		});

		// Adaptive byte budget keeps 65 verbose tools <= MAX_BRIDGE_TOOLS_BYTES without dropping any tool.
		const manyVerboseTools: Tool[] = Array.from({ length: 65 }, (_, idx) => ({
			name: `verbose_tool_${String(idx).padStart(2, "0")}`,
			description: "Long tool description ".repeat(20),
			parameters: {
				type: "object",
				properties: {
					alpha: { type: "string", description: "Alpha parameter explanation ".repeat(15) },
					beta: { type: "number", description: "Beta parameter explanation ".repeat(15) },
					gamma: { type: "boolean", description: "Gamma parameter explanation ".repeat(15) },
				},
				required: ["alpha"],
			} as never,
		}));
		const budgeted = bridgeTools(manyVerboseTools, []);
		expect(budgeted).toHaveLength(65);
		expect(Buffer.byteLength(JSON.stringify(budgeted), "utf8")).toBeLessThanOrEqual(MAX_BRIDGE_TOOLS_BYTES);
	});

	test("resolves parked tool without mid-turn detach on lazy activation or systemPrompt-only change", async () => {
		const discovered = new Map<string, Tool[]>();
		const streamFn = makeStream({ discoveredTools: (key) => discovered.get(key) ?? [] });
		const readTool: Tool = {
			name: "read",
			description: "Read file",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } as never,
		};
		const extraTool: Tool = {
			name: "mcp_extra",
			description: "Extra tool",
			parameters: { type: "object", properties: {} } as never,
		};
		discovered.set("s-no-detach", [extraTool]);

		const userMsg: Message = { role: "user", content: 'CALL_MCP:read:{"path":"a.txt"}', timestamp: 1 };
		const turn1 = await collectStream(
			streamFn(testModel, { systemPrompt: "Prompt v1", messages: [userMsg], tools: [readTool] } as never, {
				sessionId: "s-no-detach",
				streamKind: "main",
			}),
		);
		expect(turn1.final.stopReason).toBe("toolUse");
		const call = turn1.final.content.find((b) => b.type === "toolCall");
		if (call?.type !== "toolCall") throw new Error("missing toolCall");

		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: call.id,
			toolName: "read",
			isError: false,
			content: [{ type: "text", text: "PARKED-OK" }],
			timestamp: 2,
		};
		// Move extraTool from discovered -> active AND change systemPrompt while call is parked.
		discovered.set("s-no-detach", []);
		const turn2 = await collectStream(
			streamFn(
				testModel,
				{
					systemPrompt: "Prompt v2 with dynamic reminder",
					messages: [userMsg, turn1.final, toolResult],
					tools: [readTool, extraTool],
				} as never,
				{ sessionId: "s-no-detach", streamKind: "main" },
			),
		);
		expect(turn2.final.stopReason).toBe("stop");
		const text = turn2.final.content.find((b) => b.type === "text");
		expect(text?.type === "text" ? text.text : "").toBe("TOOLS=2|TOOL_OUT=PARKED-OK");

		const rows = readWorkspaceLogs(agentDir);
		expect(rows.some((r) => r.method === "session/close")).toBe(false);
		expect(rows.some((r) => r.method === "session/resume")).toBe(false);
	});

	test("batches concurrent MCP tool calls arriving within the coalesce window into one toolUse turn", async () => {
		const streamFn = makeStream({ toolBatchCoalesceMs: 30 });
		const tools: Tool[] = [
			{
				name: "read",
				description: "Read file",
				parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } as never,
			},
			{
				name: "grep",
				description: "Search files",
				parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } as never,
			},
		];
		const userMsg: Message = { role: "user", content: "CALL_MCP_PARALLEL", timestamp: 1 };
		const turn1 = await collectStream(
			streamFn(testModel, { systemPrompt: "", messages: [userMsg], tools } as never, {
				sessionId: "s-parallel",
				streamKind: "main",
			}),
		);
		expect(turn1.final.stopReason).toBe("toolUse");
		const calls = turn1.final.content.filter((b) => b.type === "toolCall");
		expect(calls).toHaveLength(2);
		expect(calls.map((c) => (c.type === "toolCall" ? c.name : "")).sort()).toEqual(["grep", "read"]);

		const results: ToolResultMessage[] = calls.map((c, idx) => {
			if (c.type !== "toolCall") throw new Error("expected toolCall");
			return {
				role: "toolResult",
				toolCallId: c.id,
				toolName: c.name,
				isError: false,
				content: [{ type: "text", text: c.name === "read" ? "R1" : "G2" }],
				timestamp: 2 + idx,
			};
		});
		const turn2 = await collectStream(
			streamFn(testModel, { systemPrompt: "", messages: [userMsg, turn1.final, ...results], tools } as never, {
				sessionId: "s-parallel",
				streamKind: "main",
			}),
		);
		expect(turn2.final.stopReason).toBe("stop");
		const text = turn2.final.content.find((b) => b.type === "text");
		expect(text?.type === "text" ? text.text : "").toBe("PARALLEL_OUT=R1+G2|TOOLS=2");
	});

	test("ignores failed unknown-tool tool_call updates while still refusing active builtin tools", async () => {
		const streamFn = makeStream();
		const survived = await collectStream(
			streamFn(
				testModel,
				{
					systemPrompt: "",
					messages: [{ role: "user", content: "EMIT_FAILED_TOOL_CALL", timestamp: 1 }],
					tools: [],
				} as never,
				{ sessionId: "s-failed-tc", streamKind: "main" },
			),
		);
		expect(survived.final.stopReason).toBe("stop");
		const text = survived.final.content.find((b) => b.type === "text");
		expect(text?.type === "text" ? text.text : "").toBe("SURVIVED_FAILED_CALL");

		const refused = await collectStream(
			streamFn(
				testModel,
				{
					systemPrompt: "",
					messages: [{ role: "user", content: "EMIT_BUILTIN_TOOL_CALL", timestamp: 1 }],
					tools: [],
				} as never,
				{ sessionId: "s-builtin-tc", streamKind: "main" },
			),
		);
		expect(refused.final.stopReason).toBe("error");
		expect(refused.final.errorMessage).toContain("agy ran its builtin tool run_command");
	});

	test("requires explicit opt-in or stored sentinel credential in auth config", async () => {
		const notOptedIn = createAntigravityAuthConfig({
			readSettings: () => ({}),
			readAuthStatus: async () => true,
			resolveExecutable: () => binPath,
			readStoredCredential: async () => undefined,
		});
		expect(await notOptedIn.check({ credential: undefined as never })).toBeUndefined();
		expect(await notOptedIn.resolveAmbient({ signal: undefined as never })).toBeUndefined();

		const enabledViaSettings = createAntigravityAuthConfig({
			readSettings: () => ({ enabled: true }),
			readAuthStatus: async () => true,
			resolveExecutable: () => binPath,
			readStoredCredential: async () => undefined,
		});
		expect(await enabledViaSettings.check({ credential: undefined as never })).toEqual({
			source: "Antigravity CLI (ACP)",
			type: "oauth",
		});
		expect(await enabledViaSettings.resolveAmbient({ signal: undefined as never })).toEqual({
			auth: { apiKey: SENTINEL_API_KEY },
			source: "Antigravity CLI (ACP)",
		});

		const enabledViaCredential = createAntigravityAuthConfig({
			readSettings: () => ({}),
			readAuthStatus: async () => true,
			resolveExecutable: () => binPath,
			readStoredCredential: async () => ({
				type: "oauth",
				access: SENTINEL_API_KEY,
				refresh: SENTINEL_API_KEY,
				expires: Number.MAX_SAFE_INTEGER,
			}),
		});
		expect(await enabledViaCredential.check({ credential: undefined as never })).toEqual({
			source: "Antigravity CLI (ACP)",
			type: "oauth",
		});
	});

	test("auto-offers eligible sibling tools from matched MCP groups on tool_search", () => {
		const offered = new Set<string>();
		const pi = {
			getAllTools: () => [
				{
					name: "mcp_superhuman_list_threads",
					exposure: "search" as const,
					allowLazyActivation: true,
					searchGroup: "superhuman",
				},
				{
					name: "mcp_superhuman_get_thread",
					exposure: "search" as const,
					allowLazyActivation: true,
					searchGroup: "superhuman",
				},
				{
					name: "mcp_superhuman_create_or_update_draft",
					exposure: "search" as const,
					allowLazyActivation: true,
					searchGroup: "superhuman",
				},
				{
					name: "mcp_superhuman_hidden",
					exposure: "hidden" as const,
					allowLazyActivation: true,
					searchGroup: "superhuman",
				},
				{
					name: "mcp_superhuman_no_lazy",
					exposure: "search" as const,
					allowLazyActivation: false,
					searchGroup: "superhuman",
				},
				{
					name: "mcp_other_tool",
					exposure: "search" as const,
					allowLazyActivation: true,
					searchGroup: "other",
				},
			],
		};
		const event = {
			toolName: "tool_search",
			isError: false,
			details: { matched: ["mcp_superhuman_list_threads"] },
			content: [
				{
					type: "text" as const,
					text: "Found 1 tool(s). Nothing was activated; call one by name and it activates on that first call:\n\n- mcp_superhuman_list_threads — List threads",
				},
			],
		};
		const rewritten = collectToolSearchMatchesForAntigravity(
			pi,
			event,
			{ model: { provider: "antigravity-acp" } as never },
			offered,
		);
		expect([...offered].sort()).toEqual([
			"mcp_superhuman_create_or_update_draft",
			"mcp_superhuman_get_thread",
			"mcp_superhuman_list_threads",
		]);
		const text = rewritten?.content?.[0]?.type === "text" ? rewritten.content[0].text : "";
		expect(text).toContain(
			"Also ready on the senpi-host MCP bridge from the same group (no extra tool_search needed):",
		);
		expect(text).toContain(`${BRIDGE_TOOL_PREFIX}mcp_superhuman_get_thread`);
		expect(text).toContain(`${BRIDGE_TOOL_PREFIX}mcp_superhuman_create_or_update_draft`);
		expect(text).not.toContain("mcp_superhuman_hidden");
		expect(text).not.toContain("mcp_superhuman_no_lazy");
		expect(text).not.toContain("mcp_other_tool");
	});

	test("pruneStaleSessionWorkspaces removes expired directories while preserving fresh and active ones", () => {
		const root = makeTmpDir("agy-prune-");
		const staleDir = join(root, "stale");
		const activeStaleDir = join(root, "active-stale");
		const freshDir = join(root, "fresh");
		mkdirSync(staleDir, { recursive: true });
		mkdirSync(activeStaleDir, { recursive: true });
		mkdirSync(freshDir, { recursive: true });

		const nowMs = 1_700_000_000_000;
		const oldDate = new Date(nowMs - 8 * 24 * 60 * 60 * 1_000);
		const freshDate = new Date(nowMs - 1 * 24 * 60 * 60 * 1_000);
		utimesSync(staleDir, oldDate, oldDate);
		utimesSync(activeStaleDir, oldDate, oldDate);
		utimesSync(freshDir, freshDate, freshDate);

		const removed = pruneStaleSessionWorkspaces(root, {
			maxAgeMs: 7 * 24 * 60 * 60 * 1_000,
			activeDirs: new Set([activeStaleDir]),
			now: nowMs,
		});
		expect(removed).toBe(1);
		expect(existsSync(staleDir)).toBe(false);
		expect(existsSync(activeStaleDir)).toBe(true);
		expect(existsSync(freshDir)).toBe(true);
	});
});

function readDirFiles(root: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const full = join(root, entry.name);
		if (entry.isDirectory()) out.push(...readDirFiles(full));
		else out.push(full);
	}
	return out;
}
