import { createAgentSession } from "../../src/core/sdk.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

export type StructuredHarness = Pick<
	Harness,
	"agent" | "session" | "authStorage" | "modelRegistry" | "settingsManager" | "tempDir" | "cleanup"
>;

/** Exercise the production SDK construction seam; createHarness's external Agent deliberately has no lane. */
export async function createStructuredHarness(
	options: Pick<HarnessOptions, "extensionFactories"> = {},
): Promise<StructuredHarness> {
	const fixture = await createHarness(options);
	fixture.session.dispose();
	try {
		const { session } = await createAgentSession({
			cwd: fixture.tempDir,
			agentDir: fixture.session.agentDir,
			model: fixture.getModel(),
			modelRuntime: fixture.session.modelRuntime,
			sessionManager: fixture.sessionManager,
			settingsManager: fixture.settingsManager,
			resourceLoader: fixture.session.resourceLoader,
			tools: [],
			autoTitleSessions: false,
		});
		return {
			...fixture,
			agent: session.agent,
			session,
			cleanup: () => {
				session.dispose();
				fixture.cleanup();
			},
		};
	} catch (error) {
		fixture.cleanup();
		throw error;
	}
}
