import { describe, expect, it } from "vitest";
import { toolResultIsError } from "../src/tool/image.ts";
import { catchCode, setup } from "./workpool/cells.ts";
import { availability, fixture, hostResult, languages, record } from "./workpool/fixture.ts";
import { WorkpoolCreateCommandSchema } from "./workpool/omo-create-schema.ts";

const createWithTools: Readonly<Record<(typeof languages)[number], string>> = {
	js: "const pool = await workpool(wpData.agent, 'batch', { mode: 'fresh', tools: ['add'] }); display({ pool_id: pool.pool_id });",
	py: "pool = workpool(wpData['agent'], 'batch', mode='fresh', tools=['add'])\ndisplay({'pool_id': pool.pool_id})",
	rb: "pool = workpool(wpData['agent'], 'batch', mode: 'fresh', tools: ['add']); display({pool_id: pool.pool_id})",
	jl: 'pool = workpool(wpData["agent"], "batch", mode="fresh", tools=["add"]); display(Dict("pool_id" => pool.pool_id))',
};

const createWithContext: Readonly<Record<(typeof languages)[number], string>> = {
	js: "await workpool(wpData.agent, 'batch', { context: 1 });",
	py: "workpool(wpData['agent'], 'batch', context=1)",
	rb: "workpool(wpData['agent'], 'batch', context: 1)",
	jl: 'workpool(wpData["agent"], "batch", context=1)',
};

function validatingHost(creates: unknown[]) {
	return async (_name: string, args: unknown) => {
		creates.push(args);
		const parsed = WorkpoolCreateCommandSchema.safeParse(args);
		if (!parsed.success) {
			return hostResult({
				error: { code: "invalid_workpool_create", message: parsed.error.issues[0]?.message ?? "invalid" },
			});
		}
		return hostResult(record);
	};
}

for (const language of languages) {
	describe.skipIf(!availability[language].detected.ok)(`${language} workpool tools`, () => {
		it("forwards tools unchanged to a host that validates with the real create schema", async () => {
			const creates: unknown[] = [];
			const f = await fixture(validatingHost(creates));
			try {
				const result = await f.run(language, `${setup[language]}\n${createWithTools[language]}`);

				expect(toolResultIsError(result), JSON.stringify(result)).toBe(false);
				expect(creates).toHaveLength(1);
				expect(WorkpoolCreateCommandSchema.safeParse(creates[0]).success).toBe(true);
				expect(creates[0]).toMatchObject({ op: "create", name: "batch", mode: "fresh", tools: ["add"] });
			} finally {
				await f.manager.dispose();
			}
		});

		it("never forwards an option the host does not know", async () => {
			const creates: unknown[] = [];
			const f = await fixture(validatingHost(creates));
			try {
				const result = await f.run(
					language,
					`${setup[language]}\n${catchCode(language, createWithContext[language])}`,
				);

				expect(creates.filter((args) => typeof args === "object" && args !== null && "context" in args)).toEqual(
					[],
				);
				expect(JSON.stringify(result)).not.toContain('"pool_id"');
			} finally {
				await f.manager.dispose();
			}
		});
	});
}
