#!/usr/bin/env node
// Standalone FluentSMTP server: the same server as `fluentsuite`, with only the SMTP module.
import { runCli } from "@fluentsuite/core";
import { smtpProduct } from "./index.js";

await runCli({ products: [smtpProduct], only: ["smtp"] });
