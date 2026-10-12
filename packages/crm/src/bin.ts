#!/usr/bin/env node
// Standalone FluentCRM server: the same server as `fluentsuite`, with only the CRM module.
import { runCli } from "@fluentsuite/core";
import { crmProduct } from "./index.js";

await runCli({ products: [crmProduct], only: ["crm"] });
