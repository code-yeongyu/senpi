import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	AgentSessionRuntime,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import {
	createFallbackCircuitAccess,
	FallbackCircuitBreaker,
	fallbackCircuitsFor,
} from "../../src/core/retry-fallback/circuit.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	while (harnesses.length) harnesses.pop()?.cleanup();
});

it("evicts an empty breaker only after every real session is disposed", async () => {
	const first = await createHarness();
	harnesses.push(first);
	const sibling = await createHarness({ siblingOf: first, siblingFreshRuntime: true });
	harnesses.push(sibling);
	const dir = join(first.tempDir, "agent");
	const breaker = fallbackCircuitsFor(dir);
	first.session.dispose();
	first.session.dispose();
	fallbackCircuitsFor(`${dir}-other`);
	expect(fallbackCircuitsFor(dir)).toBe(breaker);
	sibling.session.dispose();
	expect(fallbackCircuitsFor(dir)).not.toBe(breaker);
});

it("releases its hold even when the agent abort hook throws during disposal", async () => {
	const h = await createHarness();
	harnesses.push(h);
	const dir = join(h.tempDir, "agent");
	const breaker = fallbackCircuitsFor(dir);
	vi.spyOn(h.agent, "abort").mockImplementation(() => {
		throw new Error("abort hook failed");
	});
	expect(() => h.session.dispose()).not.toThrow();
	expect(fallbackCircuitsFor(dir)).not.toBe(breaker);
});

it("does not leak a hold when SDK startup rejects an unusable model", async () => {
	const h = await createHarness({ models: [{ id: "too-small", contextWindow: 128, maxTokens: 64 }] });
	harnesses.push(h);
	const dir = join(h.tempDir, "rejected-sdk");
	const breaker = fallbackCircuitsFor(dir);
	const manager = SessionManager.inMemory(h.tempDir);
	try {
		await expect(
			createAgentSession({
				cwd: h.tempDir,
				agentDir: dir,
				model: h.getModel(),
				modelRuntime: h.session.modelRuntime,
				settingsManager: h.settingsManager,
				resourceLoader: createTestResourceLoader(),
				sessionManager: manager,
			}),
		).rejects.toMatchObject({ name: "ModelUsabilityBudgetError" });
		fallbackCircuitsFor(`${dir}-unrelated`);
		expect(fallbackCircuitsFor(dir)).not.toBe(breaker);
	} finally {
		manager.dispose();
	}
});

it("balances breaker holds across repeated real runtime newSession replacements", async () => {
	const keeper = await createHarness();
	harnesses.push(keeper);
	const initial = await createHarness({ siblingOf: keeper });
	harnesses.push(initial);
	const dir = join(keeper.tempDir, "agent");
	const breaker = fallbackCircuitsFor(dir);
	const services = await createAgentSessionServices({
		cwd: keeper.tempDir,
		agentDir: dir,
		modelRuntime: keeper.session.modelRuntime,
		settingsManager: keeper.settingsManager,
		resourceLoaderOptions: {
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		},
	});
	const runtime = new AgentSessionRuntime(
		initial.session,
		services,
		async ({ sessionManager, sessionStartEvent }) => ({
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: keeper.getModel(),
			})),
			services,
			diagnostics: services.diagnostics,
		}),
	);
	try {
		const ids = new Set([runtime.session.sessionId, keeper.session.sessionId]);
		for (let index = 0; index < 3; index++) {
			expect(await runtime.newSession()).toEqual({ cancelled: false });
			expect(ids.has(runtime.session.sessionId)).toBe(false);
			ids.add(runtime.session.sessionId);
			fallbackCircuitsFor(`${dir}-interleaved-${index}`);
			expect(fallbackCircuitsFor(dir)).toBe(breaker);
		}
	} finally {
		await runtime.dispose();
	}
	keeper.session.dispose();
	expect(fallbackCircuitsFor(dir)).not.toBe(breaker);
});

it("keeps real session identities and background lane identities disjoint", async () => {
	const first = await createHarness();
	harnesses.push(first);
	const sibling = await createHarness({ siblingOf: first });
	harnesses.push(sibling);
	const breaker = new FallbackCircuitBreaker();
	const selector = "faux/faux-1";
	const makeAccess = (h: Harness) =>
		createFallbackCircuitAccess({
			breaker,
			owner: () => h.session.sessionId,
			now: () => 1000,
			settings: () => ({ cooldownMs: 1000, maxCooldownMs: 3000 }),
			logger: { debug() {}, info() {}, warn() {} },
		});
	const a = makeAccess(first);
	const b = makeAccess(sibling);
	breaker.open(selector, { now: 0, cooldownMs: 1000, maxCooldownMs: 3000 });
	const background = a.admit(selector, "probe-back:1");
	if (background.kind !== "probe") throw new Error("background probe not admitted");
	expect(a.admit(selector).kind).toBe("open");
	expect(a.admit(selector, "probe-back:2").kind).toBe("open");
	b.releaseAll();
	expect(b.admit(selector).kind).toBe("open");
	a.release(background.token);
	const replacement = b.admit(selector);
	expect(replacement.kind).toBe("probe");
	a.releaseAll();
	expect(a.admit(selector).kind).toBe("open");
	b.releaseAll();
	expect(a.admit(selector).kind).toBe("probe");
	a.releaseAll();
});
