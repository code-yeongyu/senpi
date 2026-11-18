import { createAgentSession } from "../../src/core/sdk.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";
import { trackCleanup } from "../support/pending-cleanups.ts";

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
			// Dispose runs before cleanup() returns, as the harness's own does: callers start closing their scope next.
			cleanup: () =>
				trackCleanup(
					new Promise<void>((resolve, reject) => {
						session.dispose();
						fixture.cleanup().then(resolve, reject);
					}),
				),
		};
	} catch (error) {
		fixture.cleanup();
		throw error;
	}
}
