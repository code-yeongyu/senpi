import { afterEach, expect, it } from "vitest";
import { cleanupIssue2184, isolateAgentDir, spawnModuleChild, srcUrl, tempDir } from "./issue-2184-support.ts";

afterEach(cleanupIssue2184);

it("main submits both positional prompts in order and applies typed extension flags", async () => {
	const agentDir = isolateAgentDir();
	const cwd = tempDir("senpi-7116-");
	const child = spawnModuleChild(
		`
		import { main } from ${JSON.stringify(srcUrl("main.ts"))};
		import { fauxAssistantMessage, fauxProvider } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
		const seen = [];
		const extension = pi => {
			const faux = fauxProvider({ provider: "flag-test", api: "flag-test", models: [{id:"fixture"}] });
			faux.setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("ok")]);
			pi.registerProvider(faux.provider);
			pi.registerFlag("fixture-bool", {type:"boolean"});
			pi.registerFlag("fixture-string", {type:"string"});
			pi.on("input", event => {
				seen.push([event.text, pi.getFlag("fixture-bool"), pi.getFlag("fixture-string")]);
			});
		};
		await main(["-p", "--offline", "--no-session", "--model", "flag-test/fixture",
			"--fixture-bool", "first prompt", "--fixture-string", "v", "second prompt"],
			{extensionFactories:[extension, pi => pi.registerFlag("fixture-string", {type:"boolean"})]});
		console.log("INPUTS " + JSON.stringify(seen));
		`,
		{ HOME: cwd, OMO_CODING_AGENT_DIR: agentDir, SENPI_CODING_AGENT_DIR: agentDir },
		cwd,
	);
	expect(await child.exit(), child.output()).toBe(0);
	expect(child.output()).toContain('INPUTS [["first prompt",true,"v"],["second prompt",true,"v"]]');
});
