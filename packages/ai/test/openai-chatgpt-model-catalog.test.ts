// #5003 W10: the SIWC picker is an account-specific server contract, not the Codex catalog.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	OpenAIChatGptModelCatalog,
	OpenAIChatGptModelCatalogError,
} from "../src/auth/oauth/openai-chatgpt-model-catalog.ts";
import { CHATGPT_SUBSCRIPTION_MODELS } from "../src/providers/chatgpt-subscription.models.ts";

const accountA = { sub: "subject-a", clientId: "client-a", access: "synthetic-a" };
const accountB = { sub: "subject-b", clientId: "client-b", access: "synthetic-b" };
const signal = new AbortController().signal;
const listed = (slug: string) => ({ slug, display_name: `Display ${slug}`, visibility: "list" });
const response = (models: unknown[]) => Response.json({ models });

describe("SIWC account model catalog", () => {
	afterEach(() => vi.restoreAllMocks());

	it("requests the inference endpoint with the selected bearer and preserves listed server order", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
			expect(url).toBe("https://api.openai.com/v1/models");
			expect(init?.method).toBe("GET");
			expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${accountA.access}`);
			expect(init?.signal).toBe(signal);
			return response([
				listed("z-new"),
				{ ...listed("hidden"), visibility: "hidden" },
				listed("a-new"),
				{ slug: "not-for-picker", display_name: "Internal" },
			]);
		});
		const catalog = new OpenAIChatGptModelCatalog();
		expect(await catalog.activate(accountA, signal)).toEqual([
			{ id: "z-new", name: "Display z-new" },
			{ id: "a-new", name: "Display a-new" },
		]);
	});

	it("keeps separate caches for both subject and issued client ID, not bearer token", async () => {
		const endpoint = vi
			.fn()
			.mockResolvedValueOnce(response([listed("a")]))
			.mockResolvedValueOnce(response([listed("b")]))
			.mockResolvedValueOnce(response([listed("other-registration")]))
			.mockResolvedValueOnce(response([listed("other-subject")]));
		vi.spyOn(globalThis, "fetch").mockImplementation(endpoint);
		const catalog = new OpenAIChatGptModelCatalog();
		await catalog.activate(accountA, signal);
		await catalog.activate(accountB, signal);
		const registration = { ...accountA, clientId: "client-c", access: accountB.access };
		await catalog.activate(registration, signal);
		const subject = { ...accountA, sub: "subject-c" };
		await catalog.activate(subject, signal);
		expect(catalog.getModels(accountA).map((model) => model.id)).toEqual(["a"]);
		expect(catalog.getModels(accountB).map((model) => model.id)).toEqual(["b"]);
		expect(catalog.getModels(registration).map((model) => model.id)).toEqual(["other-registration"]);
		expect(catalog.getModels(subject).map((model) => model.id)).toEqual(["other-subject"]);
		const rotated = { ...accountA, access: "rotated-a" };
		expect(catalog.getModels(rotated)).toEqual(catalog.getModels(accountA));
	});

	it("refreshes on every active identity switch, including a return to a cached account", async () => {
		const endpoint = vi
			.fn()
			.mockResolvedValueOnce(response([listed("old-a")]))
			.mockResolvedValueOnce(response([listed("b")]))
			.mockResolvedValueOnce(response([listed("new-a")]));
		vi.spyOn(globalThis, "fetch").mockImplementation(endpoint);
		const catalog = new OpenAIChatGptModelCatalog();
		await catalog.activate(accountA, signal);
		await catalog.activate({ ...accountA, access: "rotated-a" }, signal);
		expect(endpoint).toHaveBeenCalledTimes(1);
		await catalog.activate(accountB, signal);
		await catalog.activate(accountA, signal);
		expect(endpoint).toHaveBeenCalledTimes(3);
		expect(catalog.getModels().map((model) => model.id)).toEqual(["new-a"]);
	});

	it("merges matching static capabilities without inventing metadata for unknown slugs", async () => {
		const [known] = Object.values(CHATGPT_SUBSCRIPTION_MODELS);
		if (!known) throw new Error("static ChatGPT subscription catalog is empty");
		vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
			response([listed(known.id), listed("unknown-future-model")]),
		);
		const catalog = new OpenAIChatGptModelCatalog();
		const models = await catalog.activate(accountA, signal);
		expect(models[0]).toMatchObject({
			id: known.id,
			name: `Display ${known.id}`,
			contextWindow: known.contextWindow,
			maxTokens: known.maxTokens,
			reasoning: known.reasoning,
			thinkingLevelMap: known.thinkingLevelMap,
			input: known.input,
			cost: known.cost,
		});
		expect(models[1]).toEqual({ id: "unknown-future-model", name: "Display unknown-future-model" });
		expect(models[0]).not.toHaveProperty("upstreamModelId");
	});

	it("retains the previous account catalog and surfaces a typed HTTP failure", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			vi
				.fn()
				.mockResolvedValueOnce(response([listed("previous")]))
				.mockResolvedValueOnce(new Response("untrusted response body", { status: 503 })),
		);
		const catalog = new OpenAIChatGptModelCatalog();
		await catalog.activate(accountA, signal);
		await expect(catalog.refresh(accountA, signal)).rejects.toMatchObject({
			name: "OpenAIChatGptModelCatalogError",
			code: "model_source",
			status: 503,
		});
		expect(catalog.getModels().map((model) => model.id)).toEqual(["previous"]);
	});

	it("never shows a sibling account's cache when activation fails, and retries the failed activation", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			vi
				.fn()
				.mockResolvedValueOnce(response([listed("a")]))
				.mockResolvedValueOnce(new Response(null, { status: 403 }))
				.mockResolvedValueOnce(response([listed("b")])),
		);
		const catalog = new OpenAIChatGptModelCatalog();
		await catalog.activate(accountA, signal);
		await expect(catalog.activate(accountB, signal)).rejects.toBeInstanceOf(OpenAIChatGptModelCatalogError);
		expect(catalog.getModels()).toEqual([]);
		expect(await catalog.activate(accountB, signal)).toEqual([{ id: "b", name: "Display b" }]);
	});

	it.each([{ data: [] }, { models: [{ visibility: "list", slug: 42 }] }])(
		"rejects malformed catalog data transactionally: %j",
		async (body) => {
			vi.spyOn(globalThis, "fetch").mockImplementation(
				vi
					.fn()
					.mockResolvedValueOnce(response([listed("previous")]))
					.mockResolvedValueOnce(Response.json(body)),
			);
			const catalog = new OpenAIChatGptModelCatalog();
			await catalog.activate(accountA, signal);
			await expect(catalog.refresh(accountA, signal)).rejects.toBeInstanceOf(OpenAIChatGptModelCatalogError);
			expect(catalog.getModels().map((model) => model.id)).toEqual(["previous"]);
		},
	);

	it("publishes an empty list when the server no longer lists any models", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			vi
				.fn()
				.mockResolvedValueOnce(response([listed("previous")]))
				.mockResolvedValueOnce(response([])),
		);
		const catalog = new OpenAIChatGptModelCatalog();
		await catalog.activate(accountA, signal);
		expect(await catalog.refresh(accountA, signal)).toEqual([]);
		expect(catalog.getModels()).toEqual([]);
	});

	it("does not let an older refresh overwrite a newer catalog for the same identity", async () => {
		let finishOlder!: (value: Response) => void;
		const older = new Promise<Response>((resolve) => {
			finishOlder = resolve;
		});
		vi.spyOn(globalThis, "fetch").mockImplementation(
			vi
				.fn()
				.mockResolvedValueOnce(response([listed("initial")]))
				.mockReturnValueOnce(older)
				.mockResolvedValueOnce(response([listed("newer")])),
		);
		const catalog = new OpenAIChatGptModelCatalog();
		await catalog.activate(accountA, signal);
		const pending = catalog.refresh(accountA, signal);
		await catalog.refresh(accountA, signal);
		finishOlder(response([listed("older")]));
		await pending;
		expect(catalog.getModels().map((model) => model.id)).toEqual(["newer"]);
	});

	it("does not publish an aborted refresh even if the endpoint completes", async () => {
		const controller = new AbortController();
		vi.spyOn(globalThis, "fetch").mockImplementation(
			vi
				.fn()
				.mockResolvedValueOnce(response([listed("initial")]))
				.mockImplementationOnce(async () => {
					controller.abort(new Error("cancelled"));
					return response([listed("aborted")]);
				}),
		);
		const catalog = new OpenAIChatGptModelCatalog();
		await catalog.activate(accountA, signal);
		await expect(catalog.refresh(accountA, controller.signal)).rejects.toThrow("cancelled");
		expect(catalog.getModels().map((model) => model.id)).toEqual(["initial"]);
	});
});
