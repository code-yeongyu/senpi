import { describe, expect, it } from "vitest";
import {
	ModelUsabilityBudgetError,
	type ModelUsabilityBudgetProjection,
} from "../src/core/extensions/builtin/compaction/model-usability-budget.ts";
import { MissingSessionCwdError } from "../src/core/session-cwd.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

type RpcClientPrivate = {
	getData: <T>(response: unknown) => T;
};

const projection: ModelUsabilityBudgetProjection = {
	model: "faux/faux-small",
	contextWindow: 8192,
	liveContextTokens: 60000,
	systemPromptTokens: 3748,
	activeToolSchemaTokens: 4538,
	outputReserveTokens: 2048,
	compactionReserveTokens: 1024,
	speculationLeadTokens: 0,
	safetyMarginTokens: 8192,
	safetyMarginProfile: "default",
	requiredTokens: 79550,
	shortfallTokens: 71358,
	usable: false,
	admission: "resume",
};

describe("RpcClient budget error identity", () => {
	it("reconstructs ModelUsabilityBudgetError from a typed error response", () => {
		const client = new RpcClient();
		const getData = (client as unknown as RpcClientPrivate).getData.bind(client);

		let thrown: unknown;
		try {
			getData({
				type: "response",
				command: "switch_session",
				success: false,
				error: new ModelUsabilityBudgetError(projection).message,
				errorCode: "model_usability_budget",
				errorData: projection,
			});
		} catch (error: unknown) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(ModelUsabilityBudgetError);
		expect((thrown as ModelUsabilityBudgetError).projection).toEqual(projection);
		expect(thrown).not.toBeInstanceOf(MissingSessionCwdError);
	});

	it("falls back to a plain Error when no typed code is present", () => {
		const client = new RpcClient();
		const getData = (client as unknown as RpcClientPrivate).getData.bind(client);

		expect(() =>
			getData({
				type: "response",
				command: "switch_session",
				success: false,
				error: "boom",
			}),
		).toThrow(/boom/);
		try {
			getData({ type: "response", command: "switch_session", success: false, error: "boom" });
		} catch (error: unknown) {
			expect(error).not.toBeInstanceOf(ModelUsabilityBudgetError);
		}
	});
});
