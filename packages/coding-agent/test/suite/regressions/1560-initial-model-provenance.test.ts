import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { MOCK_MODEL, MOCK_PROVIDER, startFakeModelServer } from "../../helpers/rpc-fake-model.ts";
import { hermeticProviderEnv, writeRpcModelsJson } from "../../helpers/rpc-hermetic.ts";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../../../src/cli-main.ts", import.meta.url));
const model = `${MOCK_PROVIDER}/${MOCK_MODEL}`;

// #1560: exercise CLI resolution and the services wrapper, not a fabricated event.
it.each([
	{ name: "explicit model", args: ["--model", model], saved: true, expected: "cli" },
	{ name: "first scoped model", args: ["--models", model], saved: false, expected: "scoped" },
	{ name: "saved scoped model", args: ["--models", model], saved: true, expected: "scoped" },
	{ name: "implicit saved model", args: [], saved: true, expected: "settings" },
])(
	"preserves startup provenance for $name",
	async ({ args, saved, expected }) => {
		const root = mkdtempSync(join(tmpdir(), "senpi-provenance-"));
		const agentDir = join(root, "agent");
		mkdirSync(agentDir);
		const server = await startFakeModelServer();
		try {
			writeRpcModelsJson(agentDir, server.origin);
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify(saved ? { defaultProvider: MOCK_PROVIDER, defaultModel: MOCK_MODEL } : {}),
			);
			const extension = join(root, "capture.ts");
			writeFileSync(
				extension,
				[
					"export default function (pi) {",
					'  pi.on("session_start", (event) => {',
					'    process.stderr.write("QA_PROVENANCE:" + JSON.stringify({',
					"      type: event.type, reason: event.reason, initialModelProvenance: event.initialModelProvenance,",
					'    }) + "\\n");',
					"  });",
					"}",
				].join("\n"),
			);
			const env = { ...process.env, ...hermeticProviderEnv() };
			for (const key of Object.keys(env)) {
				if (key === "SENPI_BRAND" || key.endsWith("_CODING_AGENT_DIR") || key.endsWith("_CODING_AGENT_SESSION_DIR"))
					delete env[key];
			}
			env.SENPI_CODING_AGENT_DIR = agentDir;
			env.PI_OFFLINE = "1";
			env.SENPI_OFFLINE = "1";
			env.PI_SKIP_VERSION_CHECK = "1";
			const execution = execFileAsync(
				"bun",
				[cliPath, "--no-session", "--extension", extension, ...args, "-p", "hello"],
				{ cwd: root, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
			);
			execution.child.stdin?.end();
			const result = await execution;
			const eventLine = result.stderr.split("\n").find((line) => line.startsWith("QA_PROVENANCE:"));
			expect(eventLine, result.stderr).toBeDefined();
			const event: unknown = JSON.parse(eventLine!.slice("QA_PROVENANCE:".length));
			expect(event).toEqual({ type: "session_start", reason: "startup", initialModelProvenance: expected });
			expect(server.requests.some((request) => request.model === MOCK_MODEL)).toBe(true);
		} finally {
			await server.close();
			rmSync(root, { recursive: true, force: true });
		}
	},
	40_000,
);
