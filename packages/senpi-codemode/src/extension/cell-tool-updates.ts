import type { CellToolUpdateSink } from "../tool/nested-tool-output.ts";

/**
 * The live-update sinks of the subprocess-kernel cells running right now, keyed by the same per-run secret as
 * `CellKernelTools`: a bridge call carrying it streams its tool's partial results into that cell (#6167).
 */
export class CellToolUpdates {
	readonly #byToken = new Map<string, CellToolUpdateSink>();

	bind(token: string, sink: CellToolUpdateSink): () => void {
		this.#byToken.set(token, sink);
		return () => {
			if (this.#byToken.get(token) === sink) this.#byToken.delete(token);
		};
	}

	/** The sink bound to `token`; an absent, unknown or released token gets none. */
	sinkFor(token: string | undefined): CellToolUpdateSink | undefined {
		return token === undefined ? undefined : this.#byToken.get(token);
	}
}
