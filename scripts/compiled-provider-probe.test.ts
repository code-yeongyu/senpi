import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { on, once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { startProviderProbeServers } from "../packages/coding-agent/test/helpers/provider-probe-servers.ts";

const repo = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "senpi-compiled-provider-"));
const platform = `${process.platform}-${process.arch === "x64" ? "x64" : "arm64"}`;
const release = join(scratch, "release");
const relocated = join(scratch, "relocated");
const binary = join(relocated, "pi");
const recordSchema = z.object({
	type: z.string(), id: z.string().optional(), success: z.boolean().optional(),
	data: z.object({ sessionId: z.string().optional() }).optional(),
	message: z.object({ role: z.string(), errorMessage: z.string().optional(), stopReason: z.string().optional() }).optional(),
});
type RecordEvent = z.infer<typeof recordSchema>;

beforeAll(() => {
	// Given: the release builder on this branch, independently of other dependency-diet work.
	const build = spawnSync("bash", ["scripts/build-binaries.sh", "--skip-install", "--skip-build", "--platform", platform, "--out", release], {
		cwd: repo, encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024,
	});
	expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
	renameSync(join(release, platform), relocated);
	cpSync(join(repo, "packages/coding-agent/test/helpers/provider-probe-extension.ts"), join(relocated, "probe.ts"));
}, 310_000);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

for (const shared of [false, true]) {
	for (const index of [0, 1, 2]) {
		test(`returns auth for provider ${index} in ${shared ? "shared" : "classic"} RPC`, async () => {
			// Given: isolated state, local rejecting servers, and an extension using bundled compat APIs.
			await using probes = await startProviderProbeServers();
			const model = probes.models[index];
			if (!model) throw new Error("Missing provider fixture");
			const state = mkdtempSync(join(scratch, "state-"));
			mkdirSync(join(state, "home"));
			writeFileSync(join(state, "models.json"), JSON.stringify({ providers: Object.fromEntries(probes.models.map((entry) => [entry.provider, {
				api: entry.api, baseUrl: entry.baseUrl, apiKey: "local-probe-key",
				models: [{ id: entry.id, api: entry.api, baseUrl: entry.baseUrl, contextWindow: 200000, maxTokens: 256 }],
			}])) }));
			writeFileSync(join(state, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
			const child = spawn(binary, ["--mode", "rpc", ...(shared ? ["--multi-session"] : []), "--provider", model.provider, "--model", model.id, "-e", join(relocated, "probe.ts")], {
				cwd: state, stdio: ["pipe", "pipe", "pipe"], env: {
					PATH: process.env.PATH, HOME: join(state, "home"), TMPDIR: scratch,
					SENPI_CODING_AGENT_DIR: state, PI_OFFLINE: "1", AWS_BEDROCK_FORCE_HTTP1: "1",
					AWS_BEDROCK_SKIP_AUTH: "1", AWS_REGION: "us-east-1",
					...Object.fromEntries(probes.models.map((entry, position) => [`SENPI_PROBE_URL_${position}`, entry.baseUrl])),
				},
			});
			let stderr = "";
			child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16000); });
			const lines = createInterface({ input: child.stdout });
			const receive = async (predicate: (event: RecordEvent) => boolean): Promise<RecordEvent> => {
				for await (const args of on(lines, "line", { signal: AbortSignal.timeout(30000) })) {
					const event = recordSchema.parse(JSON.parse(z.string().parse(args[0])));
					if (predicate(event)) return event;
				}
				throw new Error(`RPC closed before the expected event: ${stderr}`);
			};
			try {
				let sessionId: string | undefined;
				if (shared) {
					const opened = receive((event) => event.id === "open-probe");
					child.stdin.write(`${JSON.stringify({ id: "open-probe", type: "open_session", cwd: state, provider: model.provider, modelId: model.id })}\n`);
					const response = await opened;
					expect(response.success, stderr).toBe(true);
					sessionId = response.data?.sessionId;
					expect(sessionId).toBeDefined();
				}
				const terminal = receive((event) => event.type === "message_end" && event.message?.role === "assistant");
				// When: a real RPC prompt invokes the selected lazy provider in its owning isolate.
				child.stdin.write(`${JSON.stringify({ id: "probe", type: "prompt", sessionId, message: "local provider probe" })}\n`);
				const event = await terminal;
				const error = event.message;
				expect(error?.stopReason).toBe("error");
				const detail = error?.errorMessage ?? "";
				const failureClass = /Cannot find|module not found|resolve.*module|ResolveMessage/i.test(detail)
					? "module-resolution" : /\b401\b|\b403\b|AccessDenied|unauthenticated/i.test(detail) ? "auth" : "other";
				console.log(JSON.stringify({ mode: shared ? "shared" : "classic", api: model.api, failureClass, detail }));
				// Then: an auth rejection, not a module-resolution failure or misleading startup success.
				expect(failureClass, `${detail}\n${stderr}`).toBe("auth");
				expect(probes.requests.some((request) => request.api === model.api)).toBe(true);
				if (index === 1) expect(probes.requests).toContainEqual({ api: model.api, path: "/agent.v1.AgentService/Run" });
			} finally {
				const exited = once(child, "exit", { signal: AbortSignal.timeout(10000) });
				child.kill("SIGKILL");
				await exited;
				lines.close();
			}
		}, 45_000);
	}
}
