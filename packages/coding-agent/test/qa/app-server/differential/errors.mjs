import { projectErrors } from "./projection.mjs";
import {
	assertErrorCode,
	initialize,
	requestError,
	runAgainstEndpoints,
} from "./scenario.mjs";

export const name = "errors";
export const expectation = "exactParity";
// The exact error matrix probes methods whose successful responses have their own
// declared expectation tiers; it is intentionally not the coverage owner for either.
export const methods = Object.freeze([]);
export const project = projectErrors;

export async function run(endpoints) {
	return runAgainstEndpoints(endpoints, async (driver) => {
		await initialize(driver, { experimentalApi: false });
		const badParams = await requestError(driver, "bad-model-list", "model/list", { limit: -1 });
		assertErrorCode(badParams, -32600, "model/list bad params");
		const experimentalOff = await requestError(driver, "experimental-off", "thread/search", { searchTerm: "needle" });
		assertErrorCode(experimentalOff, -32600, "thread/search experimental-off");
	});
}
