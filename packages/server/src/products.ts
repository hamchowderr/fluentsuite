import type { Product } from "@fluentsuite/core";
import { crmProduct } from "@fluentsuite/crm";
import { formsProduct } from "@fluentsuite/forms";
import { smtpProduct } from "@fluentsuite/smtp";

/**
 * Every product module this binary ships, in build order. Which ones are served is decided by
 * `products` in config (FLUENTSUITE_PRODUCTS). New modules (Fluent Forms, …) are added here.
 */
export const allProducts: readonly Product[] = [crmProduct, smtpProduct, formsProduct];
