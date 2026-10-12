#!/usr/bin/env node
// Standalone Fluent Forms server: the same server as `fluentsuite`, with only the Fluent Forms module.
import { runCli } from "@fluentsuite/core";
import { formsProduct } from "./index.js";

await runCli({ products: [formsProduct], only: ["forms"] });
