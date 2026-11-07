/**
 * `verify_api_key` with a Kimi Code region (senpi#5649): a region-tagged verify probes the
 * regional host, and one without a region probes the catalog host. The region is resolved
 * through the provider's own login + auth resolve, the same mapping `/login` stores, so a
 * kimi.ai key is checked on kimi.ai instead of being refused by the kimi.com host.
 *
 * Harness: the in-process classic RPC harness (`test/fixtures/rpc-classic-harness.ts`, same
 * mocks as `test/rpc-get-media.test.ts`) — commands are driven through the injected stdin
 * line handler and every emitted line is captured at the `writeRawStdout` boundary.
 * `globalThis.fetch` is stubbed: the real key gets 200, any other key 401, so the probe's
 * target host is observable without network. The Kimi region env vars are cleared so the
 * login prompts for the region instead of settling it from the host environment.
 */

import { setMaxListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createFakeRuntimeHost, type ParsedOutputLine, parseOutputLines } from "./fixtures/rpc-classic-harness.ts";

const rpcIo = {
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
};

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (chunk: string) => {
		rpcIo.outputLines.push(chunk);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	MAX_RPC_LINE_CHARACTERS: 16 * 1024 * 1024,
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

const KEY = "sk-test-0123456789abcd";
const CATALOG_HOST_MODELS = "https://api.kimi.com/coding/v1/models";
const REGIONAL_HOST_MODELS = "https://api.kimi.ai/coding/v1/models";

const REGION_ENV_VARS = ["KIMI_CODE_REGION", "KIMI_CODE_OAUTH_HOST", "KIMI_OAUTH_HOST"] as const;

interface StartedRpc {
	lineHandler: (line: string) => void;
	cleanup: () => Promise<void>;
}

async function startClassicRpc(): Promise<StartedRpc> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;

	const host = await createFakeRuntimeHost({ withSwapSession: false, withAuth: true, responseDelayMs: 0 });
	void runRpcMode(host.runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	return {
		lineHandler: rpcIo.lineHandler!,
		cleanup: host.cleanup,
	};
}

function sendCommand(lineHandler: (line: string) => void, command: Record<string, unknown>): string {
	const id = `c-${Math.random().toString(36).slice(2, 10)}`;
	lineHandler(JSON.stringify({ id, ...command }));
	return id;
}

function responseFor(id: string): ParsedOutputLine | undefined {
	return parseOutputLines(rpcIo.outputLines).find((record) => record.id === id && record.type === "response");
}

async function awaitResponse(id: string): Promise<ParsedOutputLine> {
	await vi.waitFor(() => expect(responseFor(id)).toBeDefined());
	return responseFor(id)!;
}

describe("verify_api_key with a region (senpi#5649)", () => {
	const seen: Array<{ url: string }> = [];
	let savedEnv: Array<[string, string | undefined]> = [];

	const stubFetch = (async (url: string, init?: RequestInit) => {
		const headers = (init?.headers ?? {}) as Record<string, string>;
		const sent = headers["x-api-key"] ?? headers.authorization ?? "";
		seen.push({ url });
		return new Response(null, { status: sent.includes(KEY) ? 200 : 401 });
	}) as unknown as typeof globalThis.fetch;

	beforeEach(() => {
		setMaxListeners(0, process);
		setMaxListeners(0, process.stdin);
		savedEnv = REGION_ENV_VARS.map((name) => [name, process.env[name]]);
		for (const name of REGION_ENV_VARS) delete process.env[name];
		seen.length = 0;
		vi.stubGlobal("fetch", stubFetch);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		for (const [name, value] of savedEnv) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	it("probes the regional host for a region-tagged verify, key and control alike", async () => {
		const { lineHandler, cleanup } = await startClassicRpc();
		try {
			const id = sendCommand(lineHandler, {
				type: "verify_api_key",
				provider: "kimi-coding",
				key: KEY,
				region: "global",
			});
			const response = await awaitResponse(id);
			expect(response).toMatchObject({ success: true, data: { ok: true } });
			expect(seen.map((entry) => entry.url)).toEqual([REGIONAL_HOST_MODELS, REGIONAL_HOST_MODELS]);
		} finally {
			await cleanup();
		}
	});

	it("probes the catalog host without a region", async () => {
		const { lineHandler, cleanup } = await startClassicRpc();
		try {
			const id = sendCommand(lineHandler, { type: "verify_api_key", provider: "kimi-coding", key: KEY });
			const response = await awaitResponse(id);
			expect(response).toMatchObject({ success: true, data: { ok: true } });
			expect(seen.map((entry) => entry.url)).toEqual([CATALOG_HOST_MODELS, CATALOG_HOST_MODELS]);
		} finally {
			await cleanup();
		}
	});

	it("probes the catalog host for the default region", async () => {
		const { lineHandler, cleanup } = await startClassicRpc();
		try {
			const id = sendCommand(lineHandler, {
				type: "verify_api_key",
				provider: "kimi-coding",
				key: KEY,
				region: "mainland-cn",
			});
			const response = await awaitResponse(id);
			expect(response).toMatchObject({ success: true, data: { ok: true } });
			expect(seen.map((entry) => entry.url)).toEqual([CATALOG_HOST_MODELS, CATALOG_HOST_MODELS]);
		} finally {
			await cleanup();
		}
	});

	it("fails the command for a region the provider does not offer", async () => {
		const { lineHandler, cleanup } = await startClassicRpc();
		try {
			const id = sendCommand(lineHandler, {
				type: "verify_api_key",
				provider: "kimi-coding",
				key: KEY,
				region: "nowhere",
			});
			const response = await awaitResponse(id);
			expect(response).toMatchObject({ success: false });
			expect(seen).toEqual([]);
		} finally {
			await cleanup();
		}
	});
});
