/**
 * The gateway side of the release suites: an extension standing in for omo's thread component. Its drain
 * admits the delivery ids a `wake` names, can be held mid-pass (`armLateDrain`), and a prompt can be held
 * in its `input` handler (`holdNextInput`); every admission outcome, refusals included, is recorded.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionFactory, SessionControlAdmission } from "../../src/core/extensions/types.ts";

interface Gate {
	readonly entered: () => void;
	readonly go: Promise<void>;
}

function gate(): { held: Gate; entered: Promise<void>; go: () => void } {
	let entered!: () => void;
	const enteredPromise = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let go!: () => void;
	const goPromise = new Promise<void>((resolve) => {
		go = resolve;
	});
	return { held: { entered, go: goPromise }, entered: enteredPromise, go };
}

export function gatewayFixture() {
	let armed: Gate | undefined;
	let heldInput: Gate | undefined;
	const outcomes: string[] = [];
	let inboxDir = "";
	const extension: ExtensionFactory = (pi) => {
		pi.on("input", async () => {
			const hold = heldInput;
			heldInput = undefined;
			if (hold === undefined) return;
			hold.entered();
			await hold.go;
		});
		pi.on("session_start", async (_event, ctx) => {
			inboxDir = join(`${ctx.sessionManager.getSessionFile() ?? "session"}.inbox`);
			await pi.session.registerControlEndpoint({
				inboxDir,
				drain: async (event) => {
					const admitted: SessionControlAdmission[] = [];
					const late = armed;
					if (late !== undefined && event.reasons.includes("inbox")) {
						armed = undefined;
						late.entered();
						await late.go;
					}
					for (const deliveryId of [...(event.delivery_ids ?? []), ...(late ? ["late-1"] : [])]) {
						try {
							const result = pi.session.admitExternalMessage({
								delivery_id: deliveryId,
								text: `DELIVERY ${deliveryId}`,
								deliverAs: "followUp",
							});
							outcomes.push(`${deliveryId}:${result.kind}`);
							admitted.push({ delivery_id: deliveryId, kind: result.kind });
						} catch (error) {
							outcomes.push(`${deliveryId}:refused:${error instanceof Error ? error.message : String(error)}`);
						}
					}
					return { admitted };
				},
			});
		});
	};
	return {
		extension,
		outcomes,
		armLateDrain(): { entered: Promise<void>; go: () => void; wake: () => void } {
			const late = gate();
			armed = late.held;
			return { entered: late.entered, go: late.go, wake: () => writeFileSync(join(inboxDir, "late-1"), "marker") };
		},
		holdNextInput(): { entered: Promise<void>; go: () => void } {
			const input = gate();
			heldInput = input.held;
			return { entered: input.entered, go: input.go };
		},
	};
}
