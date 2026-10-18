import { kernelToolsStorage } from "@code-yeongyu/senpi";
import type { KernelToolsCapability } from "../kernels/js/kernel-tools-types.ts";

/**
 * Kernel-tools capabilities of the subprocess-kernel cells running right now, keyed by a secret minted per run and
 * sent only to the kernel running that cell. Those kernels (py/rb/jl) reach the host over the bridge, outside the
 * submitting cell's async context, so a bridge call carries its run's secret and runs inside that run's capability:
 * the same `kernelToolsStorage` scope the JS worker path enters per host call (#1754).
 */
export class CellKernelTools {
	readonly #byToken = new Map<string, KernelToolsCapability>();

	/** Makes `capability` the kernel tools of calls carrying `token` until the returned release runs. */
	bind(token: string, capability: KernelToolsCapability): () => void {
		this.#byToken.set(token, capability);
		return () => {
			if (this.#byToken.get(token) === capability) this.#byToken.delete(token);
		};
	}

	/** Runs `call` with the capability bound to `token`; an absent, unknown or released token gets none. */
	async run<T>(token: string | undefined, call: () => Promise<T>): Promise<T> {
		const capability = token === undefined ? undefined : this.#byToken.get(token);
		return capability === undefined
			? await kernelToolsStorage.exit(call)
			: await kernelToolsStorage.run(capability, call);
	}
}
