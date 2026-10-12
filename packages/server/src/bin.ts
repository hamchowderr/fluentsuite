#!/usr/bin/env node
import { runCli } from "@fluentsuite/core";
import { allProducts } from "./products.js";

await runCli({ products: allProducts });
