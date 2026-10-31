/**
 * Kitty graphics support probe for multiplexer panes whose environment says
 * nothing about image support (herdr; senpi #3698).
 *
 * A 1x1 RGBA direct-transmission query (`a=q`) is written to the terminal; a
 * terminal that implements the Kitty graphics protocol replies with an APC
 * response naming the query's image id. Silence, an error payload, or a reply
 * for another id all mean "no graphics" — the caller must then keep the text
 * fallback instead of emitting graphics sequences blindly.
 */

export const KITTY_GRAPHICS_PROBE_TIMEOUT_MS = 500;

/** `AAAA` is base64 for four zero bytes: one 1x1 RGBA pixel. */
export function buildKittyGraphicsQuery(imageId: number): string {
	return `\x1b_Gi=${imageId},s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\`;
}

export type KittyGraphicsProbeOutcome = "ok" | "err";

/**
 * Classify one APC chunk as the answer to our query. Returns null when the
 * chunk is not a Kitty graphics response for `imageId`, so unrelated APC
 * traffic (graphics commands from other writers) is left untouched.
 */
export function parseKittyGraphicsProbeResponse(data: string, imageId: number): KittyGraphicsProbeOutcome | null {
	const start = "\x1b_G";
	const end = "\x1b\\";
	if (!data.startsWith(start) || !data.endsWith(end)) return null;

	const body = data.slice(start.length, -end.length);
	const separator = body.indexOf(";");
	if (separator === -1) return null;

	const keys = body.slice(0, separator);
	const message = body.slice(separator + 1);
	const idMatch = /(?:^|,)i=(\d+)(?:,|$)/.exec(keys);
	if (!idMatch || Number.parseInt(idMatch[1] ?? "", 10) !== imageId) return null;

	return message.startsWith("OK") ? "ok" : "err";
}
