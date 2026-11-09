// CK21 (hosted model-key custody): provider access declarations in the extension API, the per-session hook
// advertisement built from them, and the hand's hook link, which sends every bound session's advertisement first on
// each (re)connect and serves no hook request a session's advertisement on that connection did not precede.
import type { ProviderId } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { HandSessionAdvertisement, HookModelRequest, HookModelRequestReply } from "../../src/core/egress/wire.ts";
import type { SignedPlacementClaim } from "../../src/core/egress/placement-claim.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import {
	computeAdvertHash,
	createHandHookLink,
	type HandHookSession,
	handHookAccess,
	HookNotAdvertisedError,
} from "../../src/core/hand/hook-advertise.ts";
import { isUserLoopHook } from "../../src/modes/rpc/loopless-tool-handlers.ts";
import { createTestExtensionsResult } from "../utilities.ts";
import { fusedDispatch } from "./hook-request-fixture.ts";

const providers = (...ids: string[]) => ids as ProviderId[];

async function accessOf(...inputs: Array<{ path: string; factory: ExtensionFactory }>) {
	const { extensions } = await createTestExtensionsResult(inputs);
	return handHookAccess(extensions, isUserLoopHook);
}

describe("CK21: provider access declarations", () => {
	it("advertises the union of declared providers, sorted, per hook kind", async () => {
		const access = await accessOf(
			{
				path: "/user/a.ts",
				factory: (pi) => {
					pi.on("before_provider_request", () => undefined, { providers: providers("openai", "anthropic") });
					pi.on("provider_stream_event", () => undefined, { providers: providers("google") });
				},
			},
			{
				path: "/user/b.ts",
				factory: (pi) => {
					pi.on("before_provider_request", () => undefined, { providers: providers("anthropic", "groq") });
					pi.on("after_provider_response", () => undefined, { providers: providers("azure") });
				},
			},
		);
		expect(access).toEqual({
			requestHooks: ["anthropic", "groq", "openai"],
			streamHooks: ["azure", "google"],
		});
	});

	it("reads an undeclared hook as touching every provider", async () => {
		const access = await accessOf({
			path: "/user/a.ts",
			factory: (pi) => {
				pi.on("before_provider_request", () => undefined, { providers: providers("openai") });
				pi.on("before_provider_request", () => undefined);
				pi.on("provider_stream_event", () => undefined);
			},
		});
		expect(access).toEqual({ requestHooks: "*", streamHooks: "*" });
	});

	it("advertises no hooks when the user has none, and never a builtin's", async () => {
		const access = await accessOf(
			{ path: "/user/a.ts", factory: (pi) => void pi.on("tool_call", () => undefined) },
			{ path: "<builtin:probe>", factory: (pi) => void pi.on("before_provider_request", () => undefined) },
		);
		expect(access).toEqual({ requestHooks: [], streamHooks: [] });
	});

	it("drops a hook's declaration when it is unregistered", async () => {
		const { extensions } = await createTestExtensionsResult([
			{
				path: "/user/a.ts",
				factory: (pi) => {
					const off = pi.on("before_provider_request", () => undefined);
					off();
					pi.on("before_provider_request", () => undefined, { providers: providers("openai") });
				},
			},
		]);
		expect(handHookAccess(extensions, isUserLoopHook).requestHooks).toEqual(["openai"]);
	});

	it("refuses a malformed declaration at registration", async () => {
		for (const bad of [[], [""], ["ok", 3], "openai", [null]])
			await expect(
				createTestExtensionsResult([
					{
						path: "/user/bad.ts",
						factory: (pi) =>
							void pi.on("before_provider_request", () => undefined, {
								providers: bad as unknown as ProviderId[],
							}),
					},
				]),
			).rejects.toThrow(/providers/);
	});

	it("never filters the fused dispatch: a hook declared for another provider still runs there", async () => {
		const { seen, result } = await fusedDispatch((seen) => (pi) => {
			pi.on(
				"before_provider_request",
				(event) => {
					seen.push(event);
					return { declaredElsewhere: true };
				},
				{ providers: providers("some-other-provider") },
			);
		});
		expect(seen).toHaveLength(1);
		expect(result).toEqual({ declaredElsewhere: true });
	});
});

describe("CK21: the advertHash", () => {
	const base = { extensionSetHash: "sha256:ext", cwd: "/work/project", projectHooks: ["sha256:h1", "sha256:h2"] };

	it("is a stable sha256 over the extension set hash, the cwd and the project-local hook set", () => {
		const hash = computeAdvertHash(base);
		expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(computeAdvertHash({ ...base })).toBe(hash);
		expect(computeAdvertHash({ ...base, projectHooks: ["sha256:h2", "sha256:h1"] })).toBe(hash);
	});

	it("changes with each of its three inputs", () => {
		const hash = computeAdvertHash(base);
		expect(computeAdvertHash({ ...base, extensionSetHash: "sha256:other" })).not.toBe(hash);
		expect(computeAdvertHash({ ...base, cwd: "/work/elsewhere" })).not.toBe(hash);
		expect(computeAdvertHash({ ...base, projectHooks: ["sha256:h1"] })).not.toBe(hash);
	});
});

const CLAIM = {} as SignedPlacementClaim;

const session = (sessionId: string, cwd = "/work/project"): HandHookSession => ({
	sessionId,
	cwd,
	advertHash: computeAdvertHash({ extensionSetHash: "sha256:ext", cwd, projectHooks: [] }),
	requestHooks: "*",
	streamHooks: [],
	extensionProviders: [],
	handLocalProviders: [],
	handDefines: [],
});

const hookRequest = (sessionId: string, stepId = "s1"): HookModelRequest => ({
	t: "hook.model_request",
	sessionId,
	stepId,
	claim: CLAIM,
	input: { payload: { n: 1 } },
});

function recordingLink() {
	const sent: Array<HandSessionAdvertisement | HookModelRequestReply> = [];
	const served: string[] = [];
	const link = createHandHookLink({
		send: async (message) => void sent.push(message),
		serve: async (request) => {
			served.push(`${request.sessionId}/${request.stepId}`);
			return {
				t: "hook.model_request.reply",
				sessionId: request.sessionId,
				stepId: request.stepId,
				output: request.input,
			};
		},
	});
	return { link, sent, served };
}

const kinds = (sent: ReadonlyArray<HandSessionAdvertisement | HookModelRequestReply>) =>
	sent.map((message) =>
		message.t === "hand.session.advertise"
			? `advert:${message.sessionId}@${message.connectionId}`
			: `reply:${message.sessionId}/${message.stepId}`,
	);

describe("CK21: the advertisement precedes dispatch", () => {
	it("sends each bound session's advertisement, with connectionId and cwd, before serving its first request", async () => {
		const { link, sent } = recordingLink();
		await link.connect("c1", [session("a"), session("b", "/work/other")]);
		await link.receive("c1", hookRequest("a"));

		expect(kinds(sent)).toEqual(["advert:a@c1", "advert:b@c1", "reply:a/s1"]);
		expect(sent[1]).toEqual({ t: "hand.session.advertise", connectionId: "c1", ...session("b", "/work/other") });
	});

	it("re-sends every advertisement first on a reconnect, under the new connectionId", async () => {
		const { link, sent } = recordingLink();
		await link.connect("c1", [session("a")]);
		await link.receive("c1", hookRequest("a", "s1"));
		await link.connect("c2", [session("a")]);
		await link.receive("c2", hookRequest("a", "s2"));

		expect(kinds(sent)).toEqual(["advert:a@c1", "reply:a/s1", "advert:a@c2", "reply:a/s2"]);
	});

	it("refuses a request for a session not advertised on this connection, and serves nothing for it", async () => {
		const { link, sent, served } = recordingLink();
		await link.connect("c1", [session("a")]);

		await expect(link.receive("c1", hookRequest("b"))).rejects.toBeInstanceOf(HookNotAdvertisedError);
		expect(served).toEqual([]);
		expect(kinds(sent)).toEqual(["advert:a@c1"]);
	});

	it("refuses a request before any connection, and one that names an earlier connection", async () => {
		const { link, served } = recordingLink();
		await expect(link.receive("c0", hookRequest("a"))).rejects.toBeInstanceOf(HookNotAdvertisedError);
		await link.connect("c1", [session("a")]);
		await link.connect("c2", [session("a")]);
		await expect(link.receive("c1", hookRequest("a"))).rejects.toBeInstanceOf(HookNotAdvertisedError);
		expect(served).toEqual([]);
	});

	it("advertises a session bound mid-connection before it serves that session", async () => {
		const { link, sent } = recordingLink();
		await link.connect("c1", [session("a")]);
		await expect(link.receive("c1", hookRequest("b"))).rejects.toBeInstanceOf(HookNotAdvertisedError);
		await link.advertise(session("b"));
		await link.receive("c1", hookRequest("b"));

		expect(kinds(sent)).toEqual(["advert:a@c1", "advert:b@c1", "reply:b/s1"]);
	});

	it("serves a request that arrives while the connect is still sending only after its advertisement", async () => {
		const sent: string[] = [];
		const gate = Promise.withResolvers<void>();
		const link = createHandHookLink({
			send: async (message) => {
				if (message.t === "hand.session.advertise") await gate.promise;
				sent.push(message.t);
			},
			serve: async (request) => ({
				t: "hook.model_request.reply",
				sessionId: request.sessionId,
				stepId: request.stepId,
				output: request.input,
			}),
		});
		const connecting = link.connect("c1", [session("a")]);
		const receiving = link.receive("c1", hookRequest("a"));
		gate.resolve();
		await connecting;
		await receiving;

		expect(sent).toEqual(["hand.session.advertise", "hook.model_request.reply"]);
	});
});
