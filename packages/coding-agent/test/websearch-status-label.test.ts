import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import websearchExtension from "../src/core/extensions/builtin/websearch/index.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";

const ANTHROPIC_ENABLE_ENV = "PI_ANTHROPIC_WEB_SEARCH";
const OPENAI_ENABLE_ENV = "PI_OPENAI_WEB_SEARCH";

type CommandHandler = (rawArgs: string, ctx: { ui: { notify: ReturnType<typeof vi.fn> } }) => Promise<void>;
type SessionHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

describe("websearch /websearch status provider labels", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "websearch-status-label-"));
		await mkdir(join(cwd, ".pi"), { recursive: true });
		await writeFile(
			join(cwd, ".pi", "websearch.json"),
			JSON.stringify({
				strategy: "priority",
				fallback: true,
				auto: true,
				providers: [
					{ id: "primary", provider: "exa", apiKey: "test-key" },
					{ id: "backup", provider: "duckduckgo-html" },
					{ id: "native-openai-abc123", provider: "openai", apiKey: "test-key" },
				],
			}),
		);
	});

	afterEach(async () => {
		delete process.env[ANTHROPIC_ENABLE_ENV];
		delete process.env[OPENAI_ENABLE_ENV];
		await rm(cwd, { recursive: true, force: true });
	});

	it("#given active multi-provider config #when /websearch status runs #then providers render as provider/id and collapse discovered native ids", async () => {
		// given
		let sessionStart: SessionHandler | undefined;
		let statusCommand: CommandHandler | undefined;
		websearchExtension({
			registerTool: vi.fn(),
			registerCommand(_name: string, definition: { handler: CommandHandler }) {
				statusCommand = definition.handler;
			},
			on(eventName: string, handler: unknown) {
				if (eventName === "session_start") sessionStart = handler as SessionHandler;
			},
		} as unknown as ExtensionAPI);
		await sessionStart?.(
			{ type: "session_start" },
			{
				cwd,
				model: { provider: "exa", id: "exa-1", api: "openai-completions" },
				hasUI: false,
				ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
			},
		);
		const notify = vi.fn();

		// when
		await statusCommand?.("status", { ui: { notify } });

		// then
		expect(notify).toHaveBeenCalledTimes(1);
		const call = notify.mock.calls[0];
		expect(call?.[1]).toBe("info");
		expect(call?.[0]).toContain("providers=exa/primary, duckduckgo-html/backup, openai/native");
		expect(call?.[0]).not.toContain("primary/exa");
	});
});
