import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

/**
 * createAgentSessionServices flushes provider registrations queued while loading
 * extensions. Legacy (name/config) and native registrations queue in separate
 * arrays; the flush must replay the original interleaved call order so
 * last-registration-wins holds across mixed registerProvider() calls.
 */
describe("createAgentSessionServices provider registration order", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	const legacyRegistration = (name: string) => `\tpi.registerProvider(${JSON.stringify(name)}, {
\t\tbaseUrl: "https://${name}.test/v1",
\t\tapiKey: "${name}-key",
\t\tapi: "openai-completions",
\t\tmodels: [{
\t\t\tid: "${name}-model",
\t\t\tname: "${name} model",
\t\t\treasoning: false,
\t\t\tinput: ["text"],
\t\t\tcost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
\t\t\tcontextWindow: 128000,
\t\t\tmaxTokens: 4096,
\t\t}],
\t});`;

	const nativeRegistration = (id: string) => `\tpi.registerProvider({
\t\tid: ${JSON.stringify(id)},
\t\tname: "${id} native",
\t\tauth: { apiKey: { name: "key", resolve: async () => ({ auth: { apiKey: "key" }, source: "test" }) } },
\t\tgetModels: () => [],
\t\tstream() { throw new Error("unused"); },
\t\tstreamSimple() { throw new Error("unused"); },
\t});`;

	async function recordRegistrations(...registrations: string[]): Promise<string[]> {
		const tempDir = mkdtempSync(join(tmpdir(), "senpi-services-provider-order-"));
		tempDirs.push(tempDir);
		const agentDir = join(tempDir, "agent");
		const projectDir = join(tempDir, "project");
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(
			join(agentDir, "extensions", "ordered.ts"),
			`export default function (pi) {\n${registrations.join("\n")}\n}\n`,
		);

		const modelRuntime = getModelRuntime(await createInMemoryModelRegistry(AuthStorage.inMemory()));
		const applied: string[] = [];
		const registerProvider = modelRuntime.registerProvider.bind(modelRuntime);
		const registerNativeProvider = modelRuntime.registerNativeProvider.bind(modelRuntime);
		modelRuntime.registerProvider = (name, config) => {
			applied.push(`config:${name}`);
			return registerProvider(name, config);
		};
		modelRuntime.registerNativeProvider = (provider) => {
			applied.push(`native:${provider.id}`);
			return registerNativeProvider(provider);
		};

		await createAgentSessionServices({ cwd: projectDir, agentDir, modelRuntime });
		return applied;
	}

	it("flushes mixed pre-bind registrations in call order (native then legacy)", async () => {
		const applied = await recordRegistrations(nativeRegistration("ord-native"), legacyRegistration("ord-legacy"));

		expect(applied).toEqual(["native:ord-native", "config:ord-legacy"]);
	});

	it("flushes mixed pre-bind registrations in call order (legacy then native)", async () => {
		const applied = await recordRegistrations(
			legacyRegistration("ord-legacy-first"),
			nativeRegistration("ord-native"),
			legacyRegistration("ord-legacy-last"),
		);

		expect(applied).toEqual(["config:ord-legacy-first", "native:ord-native", "config:ord-legacy-last"]);
	});
});
