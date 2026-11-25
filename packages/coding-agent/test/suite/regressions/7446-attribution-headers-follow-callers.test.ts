import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";

// senpi#7446 behaviour change: a session whose callers have not granted (an undeclared wire peer included) sends its
// provider requests without the attribution headers install telemetry used to add, while the host setting is on.

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

async function attributedSession() {
	const dir = mkdtempSync(join(tmpdir(), "senpi-7446-attribution-"));
	writeFileSync(join(dir, "settings.json"), `${JSON.stringify({ enableInstallTelemetry: true })}\n`);
	const faux = registerFauxProvider({ api: "faux-attribution", provider: "openrouter", models: [{ id: "routed" }] });
	faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage("done")));
	cleanups.push(() => {
		faux.unregister();
		rmSync(dir, { recursive: true, force: true });
	});
	const auth = AuthStorage.inMemory();
	await auth.modify("openrouter", async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({ credentials: auth, modelsPath: join(dir, "models.json") });
	const model = faux.getModel("routed");
	if (model === undefined) throw new Error("faux model missing");
	modelRuntime.registerProvider("openrouter", { baseUrl: model.baseUrl, api: faux.api, models: [model] });
	const requestHeaders: Array<Promise<Record<string, string>> | undefined> = [];
	const stream = modelRuntime.streamSimple.bind(modelRuntime);
	modelRuntime.streamSimple = (requestModel, context, options) => {
		requestHeaders.push(options?.transformHeaders?.({}));
		return stream(requestModel, context, options);
	};
	const attributed = async (from: number, to: number): Promise<boolean[]> =>
		Promise.all(
			requestHeaders.slice(from, to).map(async (headers) => "X-OpenRouter-Title" in ((await headers) ?? {})),
		);
	const services = await createAgentSessionServices({
		cwd: dir,
		agentDir: dir,
		modelRuntime,
		resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true },
	});
	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager: SessionManager.inMemory(dir),
		model,
	});
	return { session, attributed, requestCount: () => requestHeaders.length };
}

it("sends a request without attribution headers while the callers have not granted, and with them after a grant", async () => {
	// given
	const { session, attributed, requestCount } = await attributedSession();

	// when
	session.setTelemetryCallersPermit(false);
	await session.prompt("not granted");
	const refusedRequests = requestCount();
	session.setTelemetryCallersPermit(true);
	await session.prompt("granted");

	// then
	expect(refusedRequests).toBeGreaterThan(0);
	expect(new Set(await attributed(0, refusedRequests))).toEqual(new Set([false]));
	expect(new Set(await attributed(refusedRequests, requestCount()))).toEqual(new Set([true]));
});
