import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import videoInExtension from "../../src/core/extensions/builtin/video-in/index.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../../src/core/extensions/types.ts";

type AnyTool = ToolDefinition<any, any, any>;
type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

interface VideoInHarness {
	tools: Map<string, AnyTool>;
	handlers: Map<string, Handler[]>;
	activeTools: string[];
}

function createVideoInHarness(initialActive: string[] = ["read_video"]): VideoInHarness {
	const tools = new Map<string, AnyTool>();
	const handlers = new Map<string, Handler[]>();
	const harness: VideoInHarness = { tools, handlers, activeTools: [...initialActive] };
	const pi = {
		registerTool: (tool: AnyTool) => tools.set(tool.name, tool),
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		getActiveTools: () => [...harness.activeTools],
		setActiveTools: (names: string[]) => {
			harness.activeTools = [...names];
		},
	} as unknown as ExtensionAPI;
	videoInExtension(pi);
	return harness;
}

function makeModel(input: ("text" | "image" | "video")[]): Model<any> {
	return {
		id: input.includes("video") ? "k3" : "other-model",
		name: "Test",
		api: "anthropic-messages",
		provider: "kimi-coding",
		baseUrl: "https://example.com",
		reasoning: true,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 131072,
	} as Model<any>;
}

function makeCtx(model: Model<any> | undefined, cwd: string): ExtensionContext {
	return { model, cwd } as unknown as ExtensionContext;
}

async function fire(harness: VideoInHarness, event: string, payload: unknown, ctx: ExtensionContext): Promise<void> {
	for (const handler of harness.handlers.get(event) ?? []) {
		await handler(payload, ctx);
	}
}

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-video-in-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

describe("video-in extension", () => {
	it("registers the read_video tool", () => {
		const harness = createVideoInHarness();
		expect(harness.tools.has("read_video")).toBe(true);
	});

	it("deactivates the tool on session_start for models without video input", async () => {
		const harness = createVideoInHarness(["read", "read_video"]);
		await fire(harness, "session_start", { type: "session_start" }, makeCtx(makeModel(["text", "image"]), "/tmp"));
		expect(harness.activeTools).toEqual(["read"]);
	});

	it("keeps the tool active on session_start for video-capable models", async () => {
		const harness = createVideoInHarness(["read", "read_video"]);
		await fire(
			harness,
			"session_start",
			{ type: "session_start" },
			makeCtx(makeModel(["text", "image", "video"]), "/tmp"),
		);
		expect(harness.activeTools).toEqual(["read", "read_video"]);
	});

	it("toggles activation across model_select transitions", async () => {
		const harness = createVideoInHarness(["read", "read_video"]);
		const nonVideo = makeModel(["text", "image"]);
		const video = makeModel(["text", "image", "video"]);

		await fire(harness, "model_select", { type: "model_select", model: nonVideo }, makeCtx(nonVideo, "/tmp"));
		expect(harness.activeTools).toEqual(["read"]);

		await fire(harness, "model_select", { type: "model_select", model: video }, makeCtx(video, "/tmp"));
		expect(harness.activeTools).toEqual(["read", "read_video"]);
	});

	it("refuses execution when the current model lacks video input", async () => {
		const harness = createVideoInHarness();
		const tool = harness.tools.get("read_video")!;
		await expect(
			tool.execute(
				"call-1",
				{ path: "clip.mp4" },
				undefined,
				undefined,
				makeCtx(makeModel(["text", "image"]), "/tmp"),
			),
		).rejects.toThrow("does not support video input");
	});

	it("rejects unsupported file extensions", async () => {
		const harness = createVideoInHarness();
		const dir = await makeTempDir();
		const tool = harness.tools.get("read_video")!;
		await expect(
			tool.execute(
				"call-1",
				{ path: "notes.txt" },
				undefined,
				undefined,
				makeCtx(makeModel(["text", "image", "video"]), dir),
			),
		).rejects.toThrow("not a supported video file");
	});

	it("returns the video as a base64 video-mime attachment", async () => {
		const harness = createVideoInHarness();
		const dir = await makeTempDir();
		const bytes = Buffer.from("fake-mp4-bytes");
		await writeFile(join(dir, "clip.mp4"), bytes);
		const tool = harness.tools.get("read_video")!;
		const result = await tool.execute(
			"call-1",
			{ path: "clip.mp4" },
			undefined,
			undefined,
			makeCtx(makeModel(["text", "image", "video"]), dir),
		);
		expect(result.content).toHaveLength(2);
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect(result.content[1]).toEqual({
			type: "image",
			data: bytes.toString("base64"),
			mimeType: "video/mp4",
		});
	});

	it("rejects empty files", async () => {
		const harness = createVideoInHarness();
		const dir = await makeTempDir();
		await writeFile(join(dir, "empty.mp4"), Buffer.alloc(0));
		const tool = harness.tools.get("read_video")!;
		await expect(
			tool.execute(
				"call-1",
				{ path: "empty.mp4" },
				undefined,
				undefined,
				makeCtx(makeModel(["text", "image", "video"]), dir),
			),
		).rejects.toThrow("is empty");
	});
});
