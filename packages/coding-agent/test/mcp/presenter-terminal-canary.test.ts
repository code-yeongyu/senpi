// D11 S3-6b gate note N2 (senpi#4249): T12's canary on the terminal path. Private form frames stay off the terminal's
// feed, its observers, its session entries and the value-free settle record.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeAll, expect, it } from "vitest";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { answerFrame, heldTerminal, terminalPresenter } from "./fixtures/presenter-terminal.ts";

const open: Array<() => Promise<void>> = [];
beforeAll(() => initTheme("dark"));
afterEach(async () => {
	for (const close of open.splice(0).reverse()) await close();
});

it("a canary in the message, schema, answer and terminal draft never reaches the feed, an observer, an entry or the audit", async () => {
	const canary = `canary-${randomUUID()}`;
	const held = heldTerminal();
	const t = await terminalPresenter({ select: held.select, input: async () => `draft ${canary}` });
	open.push(t.close);
	const desktop = await t.client();
	expect((await t.enrollDesktop(desktop)).acquired).toMatchObject({ type: "mcp_presenter_acquired" });
	const observer = await t.client(["interactive_user"]);
	const bystander = await t.client();
	expect(await observer.request({ type: "subscribe", cursor: 0 })).toMatchObject({ success: true });
	expect(await bystander.request({ type: "subscribe_sessions", mirror: true })).toMatchObject({ success: true });

	const result = t.present({
		message: `message ${canary}`,
		schema: { type: "object", properties: { name: { type: "string", title: `title ${canary}` } } },
	});
	const request = await desktop.waitFor((record) => record.type === "mcp_form_request");
	await held.shown;
	await desktop.request(answerFrame(request, "mcp_form_presented"));
	await desktop.request(answerFrame(request, "mcp_form_response", { action: "accept", content: { name: canary } }));
	const settled = await desktop.waitFor((record) => record.type === "mcp_form_settled");
	expect(await result).toMatchObject({ kind: "result", result: { content: { name: canary } } });
	for (const client of [observer, bystander]) await client.request({ type: "get_state" });

	// The canary did travel: the holder's own private request carried it.
	expect(JSON.stringify(request)).toContain(canary);
	expect(JSON.stringify(settled)).not.toContain(canary);
	expect(observer.bytes).not.toContain(canary);
	expect(bystander.bytes).not.toContain(canary);
	expect(JSON.stringify(t.harness.session.sessionManager.getEntries())).not.toContain(canary);
	const file = t.harness.session.sessionFile;
	if (file !== undefined && existsSync(file)) expect(readFileSync(file, "utf8")).not.toContain(canary);
});
