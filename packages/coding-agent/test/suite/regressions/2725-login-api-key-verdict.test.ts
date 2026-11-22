// senpi#2725: `/login` saved any API key and said only "Saved API key for X"; a refused key surfaced on some
// later request. After saving, the dialog now asks the provider once and reports its verdict; the key stays saved.
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

const PROVIDER = "fixture-provider";

const model = {
	id: "fixture-model",
	name: "Fixture Model",
	api: "openai-completions",
	provider: PROVIDER,
	baseUrl: "http://127.0.0.1:9/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8_000,
	maxTokens: 1_000,
} as unknown as Model<Api>;

type Notice = { level: string; message: string };

async function reportFor(key: string, answer: (url: string, key: string | undefined) => Response | Error) {
	const seen: string[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const headers = new Headers(init?.headers);
		const sent = headers.get("authorization")?.replace(/^Bearer /, "");
		seen.push(String(input));
		const result = answer(String(input), sent);
		if (result instanceof Error) throw result;
		return result;
	});
	const notices: Notice[] = [];
	const fakeThis = {
		session: {
			modelRegistry: {
				authStorage: { get: (id: string) => (id === PROVIDER ? { type: "api_key", key } : undefined) },
				getAll: () => [model],
			},
		},
		showLoginFailure: (notice: Notice) => notices.push(notice),
	};
	const report = Reflect.get(InteractiveMode.prototype, "reportApiKeyVerification");
	if (typeof report !== "function") throw new Error("InteractiveMode.reportApiKeyVerification is missing");
	await report.call(fakeThis, PROVIDER, "Fixture");
	return { notices, seen };
}

afterEach(() => vi.restoreAllMocks());

describe("senpi#2725 /login reports the provider's verdict on a saved API key", () => {
	it("names a refused key as rejected, with the status", async () => {
		const { notices } = await reportFor("sk-fake", () => new Response("", { status: 401 }));
		expect(notices).toEqual([{ level: "error", message: expect.stringContaining("rejected by Fixture (401)") }]);
	});

	it("says a key the provider accepts is accepted", async () => {
		const { notices } = await reportFor(
			"sk-good",
			(_url, sent) => new Response("{}", { status: sent === "sk-good" ? 200 : 401 }),
		);
		expect(notices).toEqual([{ level: "status", message: "Fixture accepted the API key." }]);
	});

	it("keeps a key it could not check and says so", async () => {
		const { notices } = await reportFor("sk-any", () => new TypeError("fetch failed"));
		expect(notices).toEqual([{ level: "status", message: expect.stringContaining("saved anyway") }]);
	});

	it("never probes a $ENV or !command reference", async () => {
		for (const key of ["$FIXTURE_KEY", "!print-key"]) {
			const { notices, seen } = await reportFor(key, () => new Response("", { status: 401 }));
			expect(notices).toEqual([]);
			expect(seen).toEqual([]);
			vi.restoreAllMocks();
		}
	});
});
