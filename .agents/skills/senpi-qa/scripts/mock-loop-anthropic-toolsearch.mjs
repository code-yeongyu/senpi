// senpi-qa Channel 3 variant: real CLI --print against the local fake Anthropic server,
// with an extension that registers a search-exposed tool so the tool-search builtin
// injects Anthropic's native tool-search server tool. Asserts the REAL wire bytes.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createChecks, evidenceDir, guardRealAuth, installCleanupHooks, makeSandbox, runCli, repoRoot } from "./lib/common.mjs";
import { startFakeModelServer } from "./lib/fake-model-server.mjs";
import { API_PRESETS, hermeticEnv, writeMockModelsJson } from "./lib/mock-loop-support.mjs";

installCleanupHooks();
const checks = createChecks("anthropic native tool-search wire contract");
const guard = guardRealAuth();
const apiName = "anthropic-messages";
const p = API_PRESETS[apiName];
const box = makeSandbox("mock-loop-anthropic-toolsearch");
const marker = "SENPI-QA-TOOLSEARCH-OK";
const server = await startFakeModelServer({ turns: [{ text: marker }] });
writeMockModelsJson(box.agentDir, server, apiName);
const typeboxUrl = pathToFileURL(join(repoRoot(), "node_modules", "typebox", "build", "index.mjs")).href;
const extPath = join(box.dir, "searchable-ext.mjs");
writeFileSync(extPath, `import { Type } from ${JSON.stringify(typeboxUrl)};
export default function(pi) {
  pi.registerTool({ name: "weather_forecast", label: "Weather", description: "Forecast weather", exposure: "search",
    parameters: Type.Object({ city: Type.String() }),
    async execute() { return { content: [{ type: "text", text: "sunny" }], details: {} }; } });
}`);
const args = ["--provider", p.provider, "--model", p.modelId, "--no-context-files", "--extension", extPath, "--print", "say the marker"];
const result = await runCli(args, { env: hermeticEnv(box.env), cwd: box.cwd, timeoutMs: 120000 });
const tools = server.requests.flatMap((r) => Array.isArray(r.tools) ? r.tools : []);
const serverTools = tools.filter((t) => typeof t.type === "string" && t.type.startsWith("tool_search_tool_"));
const canonical = serverTools.filter((t) => t.type === "tool_search_tool_bm25_20251119" && t.name === "tool_search_tool_bm25");
const badName = tools.filter((t) => typeof t.type === "string" && t.type.startsWith("tool_search_tool_") && t.name === "tool_search");
checks.ok("CLI completed", !result.timedOut && result.code === 0, "code=" + result.code);
checks.ok("fake Anthropic server received a request", server.requests.length >= 1, "requests=" + server.requests.length);
checks.ok("weather_forecast injected with defer_loading", tools.some((t) => t.name === "weather_forecast" && t.defer_loading === true));
checks.ok("exactly one native tool-search server tool with the contract type+name", canonical.length === 1 && serverTools.length === 1, JSON.stringify(serverTools));
checks.ok("no server tool named tool_search", badName.length === 0);
checks.ok("local tool_search custom tool resident and undeferred", tools.some((t) => t.name === "tool_search" && t.type === undefined && t.defer_loading === undefined));
checks.ok("final assistant text returned", (result.stdout + result.stderr).includes(marker));
const dir = evidenceDir("anthropic-toolsearch-name");
writeFileSync(join(dir, "requests.json"), JSON.stringify(server.requests, null, 2));
writeFileSync(join(dir, "stdout.txt"), result.stdout);
writeFileSync(join(dir, "stderr.txt"), result.stderr);
writeFileSync(join(dir, "wire-tools.json"), JSON.stringify(tools, null, 2));
process.stderr.write("evidence: " + dir + "\n");
guard.assertUnchanged();
await server.stop();
box.cleanup();
process.exit(checks.finish() ? 0 : 1);
