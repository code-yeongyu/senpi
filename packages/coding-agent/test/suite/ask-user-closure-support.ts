import type { ExtensionContext, ExtensionToolContext } from "../../src/core/extensions/types.ts";
import { ASYNC_QUESTIONS, createAskUserDelivery } from "./helpers/ask-user-delivery.ts";

export const QUESTIONS = [{ ...ASYNC_QUESTIONS[0], options: [{ label: "A" }, { label: "B" }] }];

export async function closureFixture() {
	const delivery = await createAskUserDelivery(1);
	const closed: unknown[] = [];
	const settled: unknown[] = [];
	const runner = delivery.harness.getExtensionRunner();
	runner.onBusEvent("ask-user:closed", (event) => closed.push(event));
	runner.onBusEvent("ask-user:settled", (event) => settled.push(event));
	return { delivery, closed, settled, runner };
}

export function executeQuestion(
	fixture: Awaited<ReturnType<typeof closureFixture>>,
	ctx: ExtensionContext,
	id: string,
	waitForAnswer: boolean,
	signal?: AbortSignal,
) {
	return fixture.delivery.tool.execute(
		id,
		{ questions: QUESTIONS, waitForAnswer },
		signal,
		undefined,
		ctx as ExtensionToolContext,
	);
}
