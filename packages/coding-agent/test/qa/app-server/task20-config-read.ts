import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RpcEnvelope } from "../../../src/modes/app-server/rpc/envelope.ts";
import { ServerCore } from "../../../src/modes/app-server/server/server-core.ts";

const root = await mkdtemp(join(tmpdir(), "senpi-task20-config-read-"));
const agentDir = join(root, "agent");
const projectDir = join(root, "project");
const projectConfigDir = join(projectDir, ".senpi");
await mkdir(agentDir, { recursive: true });
await mkdir(projectConfigDir, { recursive: true });
await writeFile(
	join(agentDir, "settings.json"),
	JSON.stringify({
		defaultProvider: "global-provider",
		defaultModel: "global-model",
		defaultThinkingLevel: "low",
		theme: "not-wire-config",
	}),
);
await writeFile(
	join(projectConfigDir, "settings.json"),
	JSON.stringify({ defaultModel: "project-model", theme: "not-wire-project" }),
);

const sent: RpcEnvelope[] = [];
const core = new ServerCore({ codexHome: agentDir, serverCwd: root, version: "2026.7.2" });
const connection = core.addConnection({
	id: "task20-config-read",
	transportKind: "stdio",
	send: (message) => {
		sent.push(message);
	},
	close: () => undefined,
});

try {
	await core.receive(connection.id, request(1, "initialize", initializeParams()));
	await core.receive(connection.id, request(2, "config/read", { cwd: projectDir, includeLayers: true }));
	const configResult = resultRecord(sent[1], 2);
	const config = recordAt(configResult, "config");
	const keys = Object.keys(config).sort();
	const snakeKeysOk =
		JSON.stringify(keys) ===
		JSON.stringify(["approval_policy", "model", "model_provider", "model_reasoning_effort", "sandbox_mode"]);
	const noFabricatedKeys = !Object.hasOwn(config, "theme") && !Object.hasOwn(config, "review_model");
	const layers = arrayAt(configResult, "layers");
	const layerTypes = layers.flatMap((layer) => {
		if (!isRecord(layer)) return [];
		const name = layer.name;
		return isRecord(name) && typeof name.type === "string" ? [name.type] : [];
	});
	const layersOk = layers.length === 2 && layerTypes.includes("user") && layerTypes.includes("project");

	await core.receive(connection.id, request(3, "configRequirements/read", undefined));
	const requirements = resultRecord(sent[2], 3).requirements;
	const requirementsNull = requirements === null;

	console.log(`SNAKE_KEYS_OK=${snakeKeysOk ? 1 : 0}`);
	console.log(`NO_FABRICATED_KEYS=${noFabricatedKeys ? 1 : 0}`);
	console.log(`LAYERS=${layers.length}`);
	console.log(`REQUIREMENTS_NULL=${requirementsNull ? 1 : 0}`);
	console.log("EXIT=0");
	if (!snakeKeysOk || !noFabricatedKeys || !layersOk || !requirementsNull) {
		throw new Error("task20 config/read assertions failed");
	}
} finally {
	await rm(root, { recursive: true, force: true });
}

function initializeParams(): Record<string, unknown> {
	return {
		clientInfo: { name: "task20", title: "Task 20", version: "0.0.1" },
		capabilities: { experimentalApi: false, requestAttestation: false },
	};
}

function request(
	id: number,
	method: string,
	params: unknown,
): {
	readonly kind: "request";
	readonly message: { readonly id: number; readonly method: string; readonly params: unknown };
} {
	return { kind: "request", message: { id, method, params } };
}

function resultRecord(message: RpcEnvelope | undefined, id: number): Record<string, unknown> {
	if (
		message === undefined ||
		!("id" in message) ||
		message.id !== id ||
		!("result" in message) ||
		!isRecord(message.result)
	) {
		throw new Error(`config method ${id} did not return a result`);
	}
	return message.result;
}

function recordAt(record: Record<string, unknown>, key: string): Record<string, unknown> {
	const value = record[key];
	if (!isRecord(value)) throw new Error(`expected ${key} to be an object`);
	return value;
}

function arrayAt(record: Record<string, unknown>, key: string): readonly unknown[] {
	const value = record[key];
	if (!Array.isArray(value)) throw new Error(`expected ${key} to be an array`);
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
