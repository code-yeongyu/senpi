/**
 * Real RPC proof for dollar skill expansion, typed invocation events, and MCP
 * loaded-surface stability.
 *
 * Run:
 *   node .agents/skills/senpi-qa/scripts/scenarios/dollar-skill-invocation-qa.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createChecks,
	evidenceDir,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	repoRoot,
} from "../lib/common.mjs";
import { startFakeModelServer } from "../lib/fake-model-server.mjs";
import { hermeticEnv, writeMockModelsJson } from "../lib/mock-loop-support.mjs";
import { TargetRpcClient } from "../lib/target-rpc-client.mjs";

const evidenceFlagIndex = process.argv.indexOf("--evidence");
const label =
	evidenceFlagIndex >= 0 ? process.argv[evidenceFlagIndex + 1] : "dollar-skill-invocation";
if (!label) {
	throw new Error("--evidence requires a value");
}

const root = repoRoot();
const checks = createChecks("dollar-skill-invocation-qa.mjs");
const guard = guardRealAuth();
const box = makeSandbox(label);
const evidence = evidenceDir(label);
const server = await startFakeModelServer({ turns: [{ text: "DOLLAR_SKILL_QA_OK" }] });
writeMockModelsJson(box.agentDir, server, "anthropic-messages");

const skillDir = join(box.cwd, "debugging");
const skillPath = join(skillDir, "SKILL.md");
mkdirSync(skillDir, { recursive: true });
writeFileSync(
	skillPath,
	"---\nname: debugging\ndescription: Debug runtime failures\n---\n\n# Debugging\n\nTrace the defect before proposing a fix.",
);

const extensionPath = join(box.agentDir, "extensions", "dollar-invocation-qa-extension.ts");
mkdirSync(join(box.agentDir, "extensions"), { recursive: true });
const writeQaExtension = (includeReloadCommand) => {
	const reloadCommand = includeReloadCommand
		? `
  pi.registerCommand("reload-proof", {
    description: "Reload proof command",
    handler: () => {},
  });`
		: "";
	writeFileSync(
		extensionPath,
		`export default function dollarInvocationQa(pi) {
  pi.registerCommand("echo", {
    description: "Echo QA command",
    handler: () => {},
  });${reloadCommand}
}
`,
	);
};
writeQaExtension(false);

const client = new TargetRpcClient({
	env: hermeticEnv(box.env),
	cwd: box.cwd,
	targetRoot: root,
	extraArgs: ["--skill", skillDir],
});
const startupTimeoutMs = 240_000;

const waitForEventType = async (type, timeoutMs = 60_000, afterIndex = 0) => {
	const startedAt = Date.now();
	process.stderr.write(`[qa] waiting for ${type}\n`);
	const existing = client.events.slice(afterIndex).find((candidate) => candidate.message.type === type);
	if (existing) {
		process.stderr.write(`[qa] received buffered ${type} after ${Date.now() - startedAt}ms\n`);
		return existing.message;
	}
	try {
		const event = await client.waitFor((candidate) => candidate.message.type === type, timeoutMs);
		process.stderr.write(`[qa] received ${type} after ${Date.now() - startedAt}ms\n`);
		return event.message;
	} catch (error) {
		process.stderr.write(
			`[qa] ${type} timed out; observed=${client.events.map((event) => event.message.type).join(",")}\n`,
		);
		throw error;
	}
};

installCleanupHooks();
try {
	const startupStartedAt = Date.now();
	await client.send(
		{ type: "set_model", provider: "anthropic", modelId: "mock-claude" },
		startupTimeoutMs,
	);
	process.stderr.write(`[qa] RPC startup handshake completed after ${Date.now() - startupStartedAt}ms\n`);
	const initialCommandsResponse = await client.send({ type: "get_commands" }, 60_000);
	const initialCommands = initialCommandsResponse.data?.commands ?? [];
	checks.ok(
		"initial commands response accepted",
		initialCommandsResponse.success === true,
		JSON.stringify(initialCommandsResponse),
	);
	checks.ok(
		"initial command snapshot does not invalidate clients",
		client.events.every((event) => event.message.type !== "commands_changed"),
		JSON.stringify(client.events.map((event) => event.message.type)),
	);

	const commandsChangedPromise = waitForEventType("commands_changed", 60_000, client.events.length);
	writeQaExtension(true);
	const commandsChanged = await commandsChangedPromise;
	const commandsResponse = await client.send({ type: "get_commands" }, 60_000);
	const commands = commandsResponse.data?.commands ?? [];
	const echoRow = commands.find((command) => command.name === "echo");
	const reloadProofRow = commands.find((command) => command.name === "reload-proof");
	const skillRow = commands.find((command) => command.name === "skill:debugging");
	checks.ok("commands response accepted", commandsResponse.success === true, JSON.stringify(commandsResponse));
	checks.ok("extension command candidate present", echoRow?.syntax === "slash", JSON.stringify(echoRow));
	checks.ok("reloaded command candidate present", reloadProofRow?.syntax === "slash", JSON.stringify(reloadProofRow));
	checks.ok("skill candidate present", skillRow?.syntax === "dollar", JSON.stringify(skillRow));
	checks.ok(
		"post-baseline commands changed matches ordered candidates",
		JSON.stringify(commandsChanged.commands) === JSON.stringify(commands),
		JSON.stringify({ commandsChanged, commands }),
	);
	checks.ok(
		"extension command precedes skill candidate",
		commands.findIndex((command) => command.name === "echo") <
			commands.findIndex((command) => command.name === "skill:debugging"),
		JSON.stringify(commands.map((command) => command.name)),
	);

	const before = await client.send({ type: "get_loaded_surfaces" });
	const invocationPromise = waitForEventType("skill_invocation");
	const settledPromise = waitForEventType("agent_settled", 60_000);

	const prompt = "Use $skill:debugging to inspect $HOME safely";
	const accepted = await client.send({ type: "prompt", message: prompt }, 60_000);
	const invocation = await invocationPromise;
	await settledPromise;
	const after = await client.send({ type: "get_loaded_surfaces" });

	const request = server.requests.find((entry) => entry.method === "POST" && entry.url?.includes("/messages"));
	const requestText = JSON.stringify(request?.messages ?? []);
	checks.ok("prompt accepted", accepted.success === true, JSON.stringify(accepted));
	checks.ok(
		"ordered dollar invocation event",
		invocation.type === "skill_invocation" &&
			Array.isArray(invocation.skills) &&
			invocation.skills.length === 1 &&
			invocation.skills[0]?.name === "debugging" &&
			invocation.skills[0]?.path === skillPath &&
			invocation.skills[0]?.syntax === "dollar",
		JSON.stringify(invocation),
	);
	checks.ok("skill instruction reached provider", requestText.includes('name=\\"debugging\\"'), requestText.slice(0, 800));
	checks.ok(
		"explicit token removed and ordinary dollar prose preserved",
		!requestText.includes("$skill:debugging") && requestText.includes("$HOME"),
		requestText.slice(0, 800),
	);
	checks.ok(
		"MCP loaded surfaces unchanged",
		JSON.stringify(before.data?.mcpServers ?? []) === JSON.stringify(after.data?.mcpServers ?? []),
		JSON.stringify({ before: before.data?.mcpServers, after: after.data?.mcpServers }),
	);
	const commandInvocationPromise = waitForEventType("command_invocation");
	const commandAccepted = await client.send({ type: "prompt", message: "/echo" }, 60_000);
	const commandInvocation = await commandInvocationPromise;
	checks.ok("command prompt accepted", commandAccepted.success === true, JSON.stringify(commandAccepted));
	checks.ok(
		"typed command invocation event",
		commandInvocation.type === "command_invocation" &&
			commandInvocation.command?.name === "echo" &&
			commandInvocation.command?.source === "extension" &&
			commandInvocation.command?.syntax === "slash",
		JSON.stringify(commandInvocation),
	);
	checks.ok(
		"command invocation emitted once",
		client.events.filter((event) => event.message.type === "command_invocation").length === 1,
		JSON.stringify(client.events.map((event) => event.message.type)),
	);
	checks.ok(
		"skill invocation emitted once",
		client.events.filter((event) => event.message.type === "skill_invocation").length === 1,
		JSON.stringify(client.events.map((event) => event.message.type)),
	);
	checks.ok("real auth unchanged", guard.assertUnchanged(), guard.path);

	writeFileSync(
		join(evidence, "rpc-dollar-skill-invocation.json"),
		JSON.stringify(
			{
				prompt,
				accepted,
				commandAccepted,
				initialCommands,
				commandsChanged,
				commands,
				commandInvocation,
				invocation,
				beforeMcpServers: before.data?.mcpServers ?? [],
				afterMcpServers: after.data?.mcpServers ?? [],
				providerRequestMessages: request?.messages ?? [],
				stderrTail: client.stderr.slice(-2_000),
			},
			null,
			2,
		),
	);
	writeFileSync(
		join(evidence, "rpc-dollar-invocation.jsonl"),
		[commandsChanged, commandInvocation, invocation].map((event) => JSON.stringify(event)).join("\n") + "\n",
	);
	writeFileSync(
		join(evidence, "VERDICT.md"),
		[
			"# Dollar Invocation RPC QA",
			"",
			"- PASS: the initial `get_commands` snapshot does not emit `commands_changed`.",
			"- PASS: an extension reload emits one `commands_changed` snapshot matching the new ordered candidates.",
			"- PASS: one accepted `/echo` invocation emits exactly one typed `command_invocation` event.",
			"- PASS: one `$skill:debugging` token emits exactly one typed `skill_invocation` event.",
			"- PASS: ordinary `$HOME` text remains literal and MCP loaded surfaces remain unchanged.",
			"",
		].join("\n"),
	);
	process.stderr.write(`evidence: ${evidence}\n`);
} finally {
	await client.close();
	await server.stop();
	box.cleanup();
}

process.exit(checks.finish() ? 0 : 1);
