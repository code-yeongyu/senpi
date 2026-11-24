import type { ChildProcess } from "node:child_process";
import { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { inheritedDuplex } from "../../utils/inherited-duplex.ts";
import { attachJsonlLineReader } from "./jsonl.ts";

/** How a relayed exchange ended: the host's `enrolled`, its explicit `unavailable`, or a channel that closed first. */
export type PresenterRelayResult = "enrolled" | "unavailable" | "closed";

export const MCP_PRESENTER_BOOTSTRAP_FD = 4;

/** The exchange window: from the first frame of a parked channel, or from the start of any other. */
export const PRESENTER_EXCHANGE_MS = 30_000;
/**
 * How long a launch channel may sit untouched before its first frame (senpi#4602): the startup decision budget G.
 * A successor's exchange starts at its P7, which can come long after its host opened the channel.
 */
export const PRESENTER_PARKING_MS = 180_000;

/** The descriptor is not authority: only this live channel's enrollment transcript can issue grants. */
export function presenterBootstrapStream(fd: number): Duplex | undefined {
	if (fd !== MCP_PRESENTER_BOOTSTRAP_FD) return undefined;
	return inheritedDuplex(fd);
}

/** Relay one bounded enrollment exchange; fd 3 and stdin are never touched. */
export function relayPresenterBootstrap(
	upstream: Duplex,
	child: ChildProcess,
	/**
	 * The launch this CLI is performing. A v2 enrollment for a different kind, or naming a predecessor other
	 * than the host this launch replaces (`null` for an initial launch), is dropped before the host sees it.
	 * `predecessorHostInstance: undefined` means nothing proves the replaced host, so no replacement enrolls.
	 */
	launch?: { readonly kind: "initial" | "replacement"; readonly predecessorHostInstance: string | null | undefined },
): Promise<PresenterRelayResult> {
	const downstream = child.stdio[MCP_PRESENTER_BOOTSTRAP_FD];
	if (!(downstream instanceof Socket)) {
		upstream.destroy();
		return Promise.resolve("closed");
	}
	return new Promise((resolve) => {
		let ended = false;
		let acknowledging: "enrolled" | "unavailable" | undefined;
		let parked = true;
		const finish = () => {
			if (ended) return;
			ended = true;
			clearTimeout(timer);
			unreadUp();
			unreadDown();
			upstream.destroy();
			downstream.destroy();
			resolve(acknowledging ?? "closed");
		};
		// Parked until the owner's first frame (a successor's exchange starts at its P7, senpi#4602), then the window.
		let timer = setTimeout(finish, PRESENTER_PARKING_MS);
		const unreadUp = attachJsonlLineReader(
			upstream,
			(line) => {
				if (parked) {
					parked = false;
					clearTimeout(timer);
					timer = setTimeout(finish, PRESENTER_EXCHANGE_MS);
				}
				if (launch) {
					try {
						const record: unknown = JSON.parse(line);
						if (
							typeof record === "object" &&
							record !== null &&
							"type" in record &&
							record.type === "enroll" &&
							"version" in record &&
							record.version === 2 &&
							(!("launchKind" in record) ||
								record.launchKind !== launch.kind ||
								launch.predecessorHostInstance === undefined ||
								!("predecessorHostInstance" in record) ||
								record.predecessorHostInstance !== launch.predecessorHostInstance)
						)
							return finish();
					} catch {
						return finish();
					}
				}
				if (!downstream.write(`${line}\n`)) finish();
			},
			{ maxLineLength: 16 * 1024, onOversizedLine: finish },
		);
		const unreadDown = attachJsonlLineReader(
			downstream,
			(line) => {
				try {
					const record: unknown = JSON.parse(line);
					acknowledging =
						typeof record === "object" &&
						record !== null &&
						"type" in record &&
						(record.type === "enrolled" || record.type === "unavailable")
							? record.type
							: undefined;
					upstream.write(`${line}\n`, () => {
						if (acknowledging) finish();
					});
				} catch {
					finish();
				}
			},
			{ maxLineLength: 16 * 1024, onOversizedLine: finish },
		);
		upstream.once("error", finish);
		downstream.once("error", finish);
		upstream.once("end", finish);
		downstream.once("end", () => {
			if (!acknowledging) finish();
		});
		child.once("exit", finish);
	});
}
