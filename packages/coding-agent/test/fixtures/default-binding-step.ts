// One case of the S21b default session store, in a Bun child (bun:sqlite): prints one JSON result line.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { openDefaultSessionStore } from "../../src/core/session-store/default-store.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { openSessionStore } from "@earendil-works/pi-agent-core";

const { root, action } = JSON.parse(process.argv[2] ?? "{}") as { root: string; action: "wire" | "jsonl" | "edited" };
const agentDir = join(root, "agent");
const sessionDir = join(root, "sessions");
const model = getModel("anthropic", "claude-sonnet-4-5");
if (model === undefined) throw new Error("no model");

async function create(sessionManager: SessionManager, sessionStore?: "jsonl") {
	const created = await createAgentSession({
		cwd: root,
		agentDir,
		model,
		settingsManager: SettingsManager.inMemory(),
		sessionManager,
		noTools: "all",
		...(sessionStore === undefined ? {} : { sessionStore }),
	});
	created.session.dispose();
}

async function storedKeys(sessionId: string): Promise<string[]> {
	const bound = await openDefaultSessionStore({ agentDir, sessionId });
	return ((await openSessionStore(bound.store, bound.epoch).load(sessionId))?.entries ?? []).map((entry) => entry.key);
}

const user = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 1 });
const sessionManager = SessionManager.create(root, sessionDir);
const first = sessionManager.appendMessage(user("question"));
await create(sessionManager, action === "jsonl" ? "jsonl" : undefined);
const second = sessionManager.appendMessage(user("after create"));
await sessionManager.settleDurableProjection();
if (action === "edited") {
	const file = sessionManager.getSessionFile() ?? "";
	const lines = readFileSync(file, "utf8").trimEnd().split("\n");
	writeFileSync(file, `${lines.slice(0, -1).join("\n")}\n`);
	const reopened = SessionManager.open(file, sessionDir);
	await create(reopened);
	console.log(
		JSON.stringify({
			sameId: reopened.getSessionId() === sessionManager.getSessionId(),
			keys: await storedKeys(reopened.getSessionId()),
			first,
			second,
		}),
	);
} else {
	console.log(JSON.stringify({ keys: await storedKeys(sessionManager.getSessionId()), first, second }));
}
