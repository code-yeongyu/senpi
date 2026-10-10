import assert from "node:assert/strict";
import { realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { type ExtensionAPI, getPackageDir } from "@code-yeongyu/senpi";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";

// Loaded by the real CLI's external TypeScript extension loader, outside node_modules.
export default async function inventoryExtension(pi: ExtensionAPI): Promise<void> {
	const schema = Type.Object({ role: Type.Literal("user"), content: Type.String() });
	const message: MessageParam = { role: "user", content: "inventory" };
	assert(Compile(schema).Check(message));
	assert(Value.Check(schema, message));
	const root = getPackageDir();
	const executable = await import(
		pathToFileURL(join(root, "dist/core/extensions/builtin/anthropic-subscription/executable.js")).href
	);
	const run = executable.resolveClaudeCodeRun(executable.defaultExecutableDeps());
	assert.equal(run.source, "bundled");
	const binaryPath = relative(realpathSync(root), realpathSync(run.executable));
	assert(!isAbsolute(binaryPath) && !binaryPath.startsWith(".."));
	const grep = await import(pathToFileURL(join(root, "dist/core/tools/grep/native-loader.js")).href);
	const native = grep.loadNativeGrep({ packageDir: root });
	const photon = await import(pathToFileURL(join(root, "dist/utils/photon.js")).href);
	const image = await photon.loadPhoton();
	assert(image, "photon wasm must load from the snapshot");
	const receipt = process.env.SENPI_INVENTORY_RECEIPT;
	assert(receipt);
	writeFileSync(
		receipt,
		JSON.stringify({ root, executable: run.executable, grep: native.diagnostic?.code ?? "native" }),
	);
	pi.registerFlag("snapshot-inventory", { description: "Runtime inventory probe", type: "boolean" });

	// One real print-mode turn through the reset-surviving faux registry; no network or credentials.
	const faux = registerFauxProvider({});
	const evalProbe = process.env.SENPI_INVENTORY_EVAL === "1";
	faux.setResponses([
		...(evalProbe
			? [
					fauxAssistantMessage(
						fauxToolCall("eval", {
							language: "js",
							code: 'print(["SNAPSHOT", "INVENTORY", "EVAL"].join("_"))',
							summary: "Verify isolated runtime bootstrap",
							on_timeout: "error",
							timeout: 30,
						}),
						{ stopReason: "toolUse" },
					),
				]
			: []),
		fauxAssistantMessage("SNAPSHOT_INVENTORY_TURN"),
	]);
	if (evalProbe)
		pi.on("tool_result", (event) => {
			if (event.toolName === "eval") {
				assert.equal(event.isError, false);
				assert(JSON.stringify(event.content).includes("SNAPSHOT_INVENTORY_EVAL"));
				writeFileSync(`${receipt}.eval`, "ok\n");
			}
		});
	pi.on("agent_end", () => {
		writeFileSync(`${receipt}.turn`, JSON.stringify({ calls: faux.state.callCount }));
	});
	pi.registerProvider("faux", {
		baseUrl: "http://localhost:0",
		apiKey: "faux",
		api: faux.api,
		models: faux.models,
	});
}
