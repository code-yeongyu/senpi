import { installKernelPowerThrottlingOptOut } from "../../src/kernels/js/power-throttling.js";

// Probe the Windows policy without loading kernel32 on any test host.
postMessage(installKernelPowerThrottlingOptOut({ platform: "win32", load: () => undefined }));
