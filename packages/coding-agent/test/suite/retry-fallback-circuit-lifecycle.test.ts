import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AgentSession } from "../../src/core/agent-session.ts";
import { fallbackCircuitsFor } from "../../src/core/retry-fallback/circuit.ts";
import { getModelRuntime } from "../model-runtime-test-utils.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length) harnesses.pop()?.cleanup();
});

it("takes no fallback breaker hold when session construction throws", async () => {
	// given: a working harness whose agent refuses a second subscriber
	const harness = await createHarness();
	harnesses.push(harness);
	const agentDir = join(harness.tempDir, "constructor-failure-agent");
	const breaker = fallbackCircuitsFor(agentDir);
	const agent = new Proxy(harness.agent, {
		get(target, key, receiver) {
			if (key === "subscribe") {
				return () => {
					throw new Error("subscribe refused");
				};
			}
			return Reflect.get(target, key, receiver);
		},
	});

	// when
	expect(
		() =>
			new AgentSession({
				agent,
				sessionManager: harness.sessionManager,
				settingsManager: harness.settingsManager,
				cwd: harness.tempDir,
				agentDir,
				modelRuntime: getModelRuntime(harness.modelRegistry),
				resourceLoader: createTestResourceLoader(),
			}),
	).toThrow("subscribe refused");

	// then: the refused construction left no owner, so the empty breaker is evictable
	fallbackCircuitsFor(`${agentDir}-unrelated`);
	expect(fallbackCircuitsFor(agentDir)).not.toBe(breaker);
});
