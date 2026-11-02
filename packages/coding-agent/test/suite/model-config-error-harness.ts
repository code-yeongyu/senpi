import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { registerFallbackModels } from "./fallback-provider-fixture.ts";
import { createHarness, type Harness } from "./harness.ts";

// Shared by the senpi#4282 regressions: a primary model with a two-rung fallback chain on other accounts, and every
// place provider error text can reach.
export const primary = "faux/faux-1";
export const modelNotFound = '400 {"code":"model_not_found","message":"unknown provider for model faux-1"}';

export async function chainedHarness(
	harnesses: Harness[],
	options: { persistSession?: boolean } = {},
): Promise<Harness> {
	const harness = await createHarness({
		models: [{ id: "faux-1" }, { id: "faux-2" }, { id: "faux-3" }],
		persistSession: options.persistSession,
		settings: {
			retry: {
				enabled: true,
				maxRetries: 3,
				baseDelayMs: 1,
				fallbackChains: { [primary]: ["other-faux/faux-2", "third-faux/faux-3"] },
			},
		},
	});
	harnesses.push(harness);
	registerFallbackModels(harness, "other-faux", ["faux-2"]);
	registerFallbackModels(harness, "third-faux", ["faux-3"]);
	return harness;
}

export function fallbackLogEvents(harness: Harness): readonly Record<string, unknown>[] {
	return readFileSync(join(harness.tempDir, "agent", "logs", "fallback.log"), "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function filesText(dir: string): string {
	return readdirSync(dir, { recursive: true, encoding: "utf8" })
		.map((name) => join(dir, name))
		.filter((path) => statSync(path).isFile())
		.map((path) => readFileSync(path, "utf8"))
		.join("\n");
}

// The emitted session events (what RPC, --mode json, the UI and extensions receive), every log file under the agent
// dir, and the persisted session file.
export function everySink(harness: Harness): Record<string, string> {
	return {
		events: JSON.stringify(harness.events),
		logs: filesText(join(harness.tempDir, "agent", "logs")),
		session: filesText(join(harness.tempDir, "sessions")),
	};
}

export function persistedSessionText(harness: Harness): string {
	return filesText(join(harness.tempDir, "sessions"));
}

export function lastErrorMessage(harness: Harness): string | undefined {
	const last = harness.session.state.messages.at(-1);
	return last?.role === "assistant" ? last.errorMessage : undefined;
}
