import { readFileSync } from "node:fs";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import chatReplyScrubExtension, {
	scrubAssistantMessage,
	stripAgentScaffold,
} from "../../src/core/extensions/builtin/chat-reply-scrub/index.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

// senpi#2398: on the chat surface a finalized reply loses coding-agent scaffolding (routing line,
// handoff block, todo ledger) before it is emitted or persisted. Answer text that merely looks
// like a label, a plan or a checklist passes through byte-identical.

const KO_LEAK = [
	"민수님, 이건 오늘 날씨를 알려달라는 요청으로 읽었어. 제공된 자료만으로 확인되는 내용만 답할게. 여기서 멈출 조건은 확인된 정보만 전달하는 거야.",
	"지금 받은 자료에는 오늘 날씨 정보가 없어. 기상청 앱에서 확인하는 게 제일 정확해.",
].join("\n");

const KO_LEAK_POLITE = [
	"지수님, 이 말은 설치 가이드가 있으면 좋겠다는 바람으로 읽었어요. 부담 없이 공감하고, 짧게 제안한 뒤 멈출게요.",
	"그러게요, 설치부터 설정까지 한 번에 보는 가이드가 있으면 편하겠네요.",
].join("\n");

const EN_LEAK =
	"I read this as a request for install steps - list them. I'll stop when the steps are posted.\nRun `bun install`, then `bun run build`.";

const UNCHANGED = [
	"Here is the release checklist you asked for:\n- [ ] bump the version\n- [ ] tag\n- [x] changelog",
	"The migration ran cleanly.\nNext: run the backfill on staging, then tell me the row count.",
	"Now: the build is green on main.",
	"Todo: nothing left on your side.",
	"Plan for the release:\nNow: freeze the branch.\nNext: tag it on Friday.",
	"배포 계획이에요.\n지금 집중하는 것: 브랜치 동결\n다음 계획: 금요일 태그",
	"민수님, 맞아요. 설정 파일은 ~/.omo/omo.jsonc 에 있어요.\n다음 버전에서 바뀔 수 있어요.",
	"사진은 제가 제대로 못 읽었어요. 글자를 텍스트로 적어주시면 다시 볼게요.",
];

describe("stripAgentScaffold", () => {
	it("strips a Korean routing line and its stop sentence, keeping the address and the answer", () => {
		const result = stripAgentScaffold(KO_LEAK);

		expect(result.text).toBe(
			"민수님, 지금 받은 자료에는 오늘 날씨 정보가 없어. 기상청 앱에서 확인하는 게 제일 정확해.",
		);
		expect(result.removed.filter((line) => line.startsWith("routing:"))).toHaveLength(3);
	});

	it("strips the polite Korean form", () => {
		const result = stripAgentScaffold(KO_LEAK_POLITE);

		expect(result.text).toBe("지수님, 그러게요, 설치부터 설정까지 한 번에 보는 가이드가 있으면 편하겠네요.");
	});

	it("strips an English routing line", () => {
		expect(stripAgentScaffold(EN_LEAK).text).toBe("Run `bun install`, then `bun run build`.");
	});

	it("reports a reply that was only a routing line as empty", () => {
		const result = stripAgentScaffold("민수님, 이건 인사로 읽었어. 짧게 인사하고 여기서 멈출게.");

		expect(result).toMatchObject({ text: "", empty: true });
	});

	it("strips a multi-line handoff block together with the checklist inside it", () => {
		const reply = [
			"Install is one line: `bun install`.",
			"",
			"> Ask: install steps - wanted: the command.",
			"For you: ledger 2/3 done.",
			"Now: install guide.",
			"Next: wrap up.",
			"- [x] confirm the install command",
		].join("\n");

		const result = stripAgentScaffold(reply);

		expect(result.text).toBe("Install is one line: `bun install`.");
		expect(result.removed).toHaveLength(5);
	});

	it("strips a todo ledger block that carries an Overall marker", () => {
		const reply = [
			"All three steps are done.",
			"",
			"Overall: 3/3 done, 0 open.",
			"- [x] build",
			"- [x] test",
			"- [x] ship",
		].join("\n");

		expect(stripAgentScaffold(reply).text).toBe("All three steps are done.");
	});

	it.each(UNCHANGED)("passes answer text through unchanged: %s", (reply) => {
		expect(stripAgentScaffold(reply)).toEqual({ text: reply, removed: [], empty: false });
	});
});

describe("scrubAssistantMessage", () => {
	it("rewrites visible text only, leaving thinking, tool calls and model-only text as they were", () => {
		const modelOnly = { ...fauxText(EN_LEAK), audience: "model" as const };
		const message: AssistantMessage = fauxAssistantMessage([
			fauxThinking(EN_LEAK),
			fauxText(EN_LEAK),
			fauxToolCall("read", { path: "I read this as a path. I'll stop when done." }),
			modelOnly,
		]);

		const scrubbed = scrubAssistantMessage(message);

		expect(scrubbed?.content).toEqual([
			message.content[0],
			{ ...message.content[1], text: "Run `bun install`, then `bun run build`." },
			message.content[2],
			modelOnly,
		]);
	});

	it("returns nothing for a clean reply", () => {
		expect(scrubAssistantMessage(fauxAssistantMessage("The build is green."))).toBeUndefined();
	});
});

describe("chat-reply-scrub extension", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.unstubAllEnvs();
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function persistedAssistantText(surface: string): Promise<{ inMemory: string; onDisk: string }> {
		vi.stubEnv("SENPI_PROMPT_SURFACE", surface);
		const harness = await createHarness({ extensionFactories: [chatReplyScrubExtension], persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(EN_LEAK)]);

		await harness.session.prompt("How do I install it?");

		const entry = harness.sessionManager
			.getEntries()
			.find((candidate) => candidate.type === "message" && candidate.message.role === "assistant");
		if (entry?.type !== "message") throw new Error("no persisted assistant message");
		const file = harness.sessionManager.getSessionFile();
		if (!file) throw new Error("session file was not created");
		const diskEntry = readFileSync(file, "utf-8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as { type: string; message?: { role: string; content: unknown } })
			.find((candidate) => candidate.type === "message" && candidate.message?.role === "assistant");
		if (!diskEntry?.message) throw new Error("no assistant message in the session file");
		return { inMemory: getMessageText(entry.message), onDisk: getMessageText(diskEntry.message) };
	}

	it("removes the routing line from a chat-surface session's persisted reply", async () => {
		const persisted = await persistedAssistantText("chat");

		expect(persisted).toEqual({
			inMemory: "Run `bun install`, then `bun run build`.",
			onDisk: "Run `bun install`, then `bun run build`.",
		});
	});

	it.each(["terminal", "app"])("leaves a %s session's reply untouched", async (surface) => {
		const persisted = await persistedAssistantText(surface);

		expect(persisted).toEqual({ inMemory: EN_LEAK, onDisk: EN_LEAK });
	});
});
