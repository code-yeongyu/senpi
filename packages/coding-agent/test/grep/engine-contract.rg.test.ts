import { createRgEngine } from "../../src/core/tools/grep/rg-engine.ts";
import { describeEngineContract } from "./engine-contract.ts";

describeEngineContract("rg", createRgEngine);
