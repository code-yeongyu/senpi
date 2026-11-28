import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "../../model-runtime-test-utils.ts";
import { getMessageText } from "../harness.ts";
import { expectTtsrActivation } from "../ttsr-activation-assertions.ts";

it("disables TTSR from settings alone and re-enables it on session reload", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-ttsr-settings-"));
	const faux = registerFauxProvider();
	try {
		const agentDir = join(cwd, "agent");
		mkdirSync(agentDir);
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({ enabledBuiltinExtensions: ["ttsr"], disabledBuiltinExtensions: ["ttsr"] }),
		);

		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRegistry = await createInMemoryModelRegistry(authStorage);
		modelRegistry.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, models: [model] });
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({ cwd, agentDir, model, modelRegistry, sessionManager });

		try {
			const imitation = '<unavailable-tool-call name="apply_patch"> inert imitation';
			faux.setResponses([fauxAssistantMessage([fauxText(imitation)])]);
			await session.prompt("edit the first file");
			expect(getMessageText(session.messages.at(-1))).toBe(imitation);
			expect(faux.getCallLog()).toHaveLength(1);

			writeFileSync(settingsPath, JSON.stringify({ enabledBuiltinExtensions: ["ttsr"] }));
			expect(await session.reload()).toEqual({ cancelled: false });
			faux.setResponses([
				fauxAssistantMessage([fauxText(imitation)]),
				fauxAssistantMessage([fauxText("recovered after the interruption")]),
			]);
			await session.prompt("edit the second file");

			expectTtsrActivation(sessionManager.getEntries(), {
				owner: "fabricated-unavailable-tool-call",
				rules: ["fabricated-unavailable-tool-call"],
				remediation: "nudge",
			});
			expect(getMessageText(session.messages.at(-1))).toBe("recovered after the interruption");
		} finally {
			session.dispose();
		}
	} finally {
		faux.unregister();
		rmSync(cwd, { recursive: true });
	}
});
