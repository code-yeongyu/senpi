import { writeFileSync } from "node:fs";

/** Reports the refusal out of band: a host call cannot carry the signal while all 264 slots are held. */
export async function fanOut(
	args: { readonly marker: string },
	host: { call(name: string, args: unknown): Promise<unknown> },
) {
	const settled = await Promise.allSettled(
		Array.from({ length: 265 }, (_unused, index) =>
			host.call("count", { index }).catch((error: unknown) => {
				writeFileSync(args.marker, "");
				throw error;
			}),
		),
	);
	const failed = settled.flatMap((outcome, index) =>
		outcome.status === "rejected"
			? [
					{
						index,
						code: String(Reflect.get(Object(outcome.reason), "code")),
						message: String(Reflect.get(Object(outcome.reason), "message")),
					},
				]
			: [],
	);
	return { ok: settled.length - failed.length, failed };
}
