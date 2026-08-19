import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];
const APP_SERVER_SCENARIO = `
const { createAppServerRuntime } = await import("./src/modes/app-server/runtime.ts");
const accountFirst = process.argv[1] === "account-first";
const sent = [];
const runtime = createAppServerRuntime(() => undefined);
const connection = runtime.core.addConnection({
  id: accountFirst ? "account-first" : "direct",
  transportKind: "stdio",
  send: (message) => sent.push(message),
  close: () => undefined,
});
let nextId = 1;
const request = async (method, params) => {
  const id = nextId++;
  await runtime.core.receive(connection.id, {
    kind: "request",
    message: params === undefined ? { id, method } : { id, method, params },
  });
  const response = sent.find((message) => "id" in message && message.id === id);
  if (response === undefined || !("result" in response)) {
    throw new Error(method + " failed: " + JSON.stringify(response));
  }
  return response.result;
};
try {
  await request("initialize", {
    clientInfo: { name: "t3code_desktop", title: "T3 Code", version: "0" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  await runtime.core.receive(connection.id, { kind: "notification", message: { method: "initialized" } });
  if (accountFirst) await request("account/read", {});
  const result = await request("model/list", {});
  const ids = result.data.map((model) => model.id).sort();
  process.stdout.write(JSON.stringify(ids));
} finally {
  runtime.core.removeConnection(connection.id);
  runtime.dispose();
}
`;

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runModelListSequence(root: string, accountFirst: boolean): Promise<readonly string[]> {
	const home = join(root, "home");
	const agentDir = join(root, "agent");
	await mkdir(home, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		join(agentDir, "auth.json"),
		JSON.stringify({ anthropic: { type: "api_key", key: "fake-isolated-key" } }),
		{ mode: 0o600 },
	);
	await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {} }), { mode: 0o600 });
	const { stdout } = await execFileAsync(
		process.execPath,
		[
			"--import",
			"tsx",
			"--input-type=module",
			"--eval",
			APP_SERVER_SCENARIO,
			accountFirst ? "account-first" : "direct",
		],
		{
			cwd: new URL("../../../", import.meta.url),
			env: {
				HOME: home,
				PATH: process.env.PATH ?? "",
				SENPI_CODING_AGENT_DIR: agentDir,
				SENPI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
				PI_OFFLINE: "1",
				NO_COLOR: "1",
			},
		},
	);
	const parsed: unknown = JSON.parse(stdout);
	if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === "string")) {
		throw new Error("model/list scenario returned invalid model ids");
	}
	return parsed;
}

describe("Codex app-server model/list after account/read", () => {
	it("returns the same configured catalog when account/read runs first", async () => {
		// Given: two fresh real app-server processes with identical isolated on-disk auth and model configuration.
		const root = await mkdtemp(join(tmpdir(), "senpi-model-list-account-read-"));
		temporaryRoots.push(root);

		// When: one process lists directly and the other follows T3's account/read-first request order.
		const [directIds, accountFirstIds] = await Promise.all([
			runModelListSequence(join(root, "direct"), false),
			runModelListSequence(join(root, "account-first"), true),
		]);

		// Then: account/read preserves the same non-empty model catalog.
		expect(directIds.length).toBeGreaterThan(0);
		expect(accountFirstIds).toEqual(directIds);
	});
});
