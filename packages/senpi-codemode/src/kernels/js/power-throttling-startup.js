// senpi#6125: imported first by every eval kernel entry, before interpose.js captures the launchers.
import { installKernelPowerThrottlingOptOut } from "./power-throttling.js";

installKernelPowerThrottlingOptOut();
