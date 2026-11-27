import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, type ProviderHeaders, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SessionTelemetryCallers } from "../../../src/core/telemetry-consent.ts";

// senpi#7446 rule for provider attribution headers (app identity only): the host's install-telemetry setting decides
// for an unanswered caller, as before; an explicit decline or revoke by any caller removes them from the next request.

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

async function attributedSession(installTelemetry: boolean) {
	const dir = mkdtempSync(join(tmpdir(), "senpi-7446-attribution-"));
	writeFileSync(join(dir, "settings.json"), `${JSON.stringify({ enableInstallTelemetry: installTelemetry })}\n`);
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
	const requestHeaders: Array<Promise<ProviderHeaders> | ProviderHeaders | undefined> = [];
	const transforms: Array<(headers: ProviderHeaders) => Promise<ProviderHeaders> | ProviderHeaders> = [];
	const stream = modelRuntime.streamSimple.bind(modelRuntime);
	modelRuntime.streamSimple = (requestModel, context, options) => {
		if (options?.transformHeaders !== undefined) transforms.push(options.transformHeaders);
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
	return { session, attributed, transforms, requestCount: () => requestHeaders.length };
}

async function attributedPrompts(
	installTelemetry: boolean,
	answers: ReadonlyArray<(callers: SessionTelemetryCallers) => void>,
): Promise<boolean[][]> {
	const { session, attributed, requestCount } = await attributedSession(installTelemetry);
	const callers = new SessionTelemetryCallers("unanswered");
	const perPrompt: boolean[][] = [];
	for (const [index, answer] of answers.entries()) {
		answer(callers);
		session.setTelemetryCallers(callers.verdict());
		const before = requestCount();
		await session.prompt(`prompt ${index}`);
		perPrompt.push([...new Set(await attributed(before, requestCount()))]);
	}
	return perPrompt;
}

it("leaves a classic launch on the host setting alone for both events and headers", async () => {
	// given
	const on = await attributedSession(true);
	const off = await attributedSession(false);

	// when
	await on.session.prompt("classic on");
	await off.session.prompt("classic off");

	// then
	expect([on.session.telemetryPermitted(), off.session.telemetryPermitted()]).toEqual([true, false]);
	expect([...new Set(await on.attributed(0, on.requestCount()))]).toEqual([true]);
	expect([...new Set(await off.attributed(0, off.requestCount()))]).toEqual([false]);
});

it("keeps the headers for an unanswered caller while the host setting is on", async () => {
	const perPrompt = await attributedPrompts(true, [(callers) => callers.answer("older-peer", "unanswered")]);

	expect(perPrompt).toEqual([[true]]);
});

it("removes the headers when a caller declined", async () => {
	const perPrompt = await attributedPrompts(true, [(callers) => callers.answer("desktop", "declined")]);

	expect(perPrompt).toEqual([[false]]);
});

it("removes the headers from the next request after a caller revokes mid-session", async () => {
	const perPrompt = await attributedPrompts(true, [
		(callers) => callers.answer("desktop", "granted"),
		(callers) => callers.answer("desktop", "declined"),
	]);

	expect(perPrompt).toEqual([[true], [false]]);
});

it("decides the headers when a request is sent, so a request prepared before a revoke leaves without them", async () => {
	// given
	const { session, transforms } = await attributedSession(true);
	const callers = new SessionTelemetryCallers("granted");
	session.setTelemetryCallers(callers.verdict());
	await session.prompt("prepared while granted");
	const prepared = transforms.at(-1);
	if (prepared === undefined) throw new Error("no provider request was prepared");

	// when
	callers.answer("desktop", "declined");
	session.setTelemetryCallers(callers.verdict());
	const sentAfterRevoke = await prepared({});

	// then
	expect("X-OpenRouter-Title" in sentAfterRevoke).toBe(false);
});

it("keeps the headers off while the host setting is off, whatever the caller answered", async () => {
	const perPrompt = await attributedPrompts(false, [(callers) => callers.answer("desktop", "granted")]);

	expect(perPrompt).toEqual([[false]]);
});
