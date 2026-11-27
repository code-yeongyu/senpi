// senpi#6125: opt this process, and every child this JavaScript realm starts, out of Windows EcoQoS throttling.
// Imported by every process and worker entry, because the throttling state and the launcher patch are per process and
// per realm. A no-op off Windows, on Node, and with SENPI_KEEP_POWER_THROTTLING=1.
import { ensureWindowsPowerThrottlingOptOut } from "./core/windows-power-throttling.ts";

ensureWindowsPowerThrottlingOptOut();
