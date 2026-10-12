import { loadConfig, type ProductId } from "./config.js";
import { isFluentSuiteError } from "./errors.js";
import { createServerFactory, type Product, SERVER_VERSION } from "./server.js";
import { runStdio, startHttp } from "./transports.js";

const USAGE = `Usage: fluentsuite [--stdio | --http] [--config <file>]

  --stdio            Serve over stdio (default). For Claude Desktop and Claude Code.
  --http             Serve Streamable HTTP (stateless). For hosted use.
  --config <file>    JSON config file (same as FLUENTSUITE_CONFIG).
  --version          Print the version.

Configuration comes from FLUENTSUITE_* environment variables and/or the config file.
See README.md for the full list.`;

/**
 * Shared entry point for the combined binary and each standalone product binary.
 * `only` forces a product set (standalone binaries), ignoring `products` in config.
 */
export async function runCli(options: {
  products: readonly Product[];
  argv?: string[];
  only?: ProductId[];
}): Promise<void> {
  const argv = options.argv ?? process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stderr.write(`${USAGE}\n`);
    return;
  }
  if (argv.includes("--version")) {
    process.stderr.write(`${SERVER_VERSION}\n`);
    return;
  }
  const configIndex = argv.indexOf("--config");
  const path = configIndex >= 0 ? argv[configIndex + 1] : undefined;
  try {
    const config = loadConfig({
      ...(path ? { path } : {}),
      ...(options.only ? { overrides: { products: options.only } } : {}),
    });
    const factory = createServerFactory({ config, products: options.products });
    if (argv.includes("--http")) {
      const handle = await startHttp(factory, config.http);
      const stop = () => void handle.close().then(() => process.exit(0));
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    } else {
      const handle = runStdio(factory);
      process.on("SIGINT", () => void handle.close());
    }
  } catch (error) {
    process.stderr.write(
      `${isFluentSuiteError(error) || error instanceof Error ? error.message : "Failed to start."}\n`,
    );
    process.exitCode = 1;
  }
}
