import { redact, redactValue } from "./redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * A JSON-lines logger that writes to stderr (stdout is the MCP channel on stdio). Every message
 * and field passes through redaction, so a careless call site cannot leak secrets or emails.
 */
export function createLogger(
  level: LogLevel = "info",
  sink: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Logger {
  const emit = (
    lvl: Exclude<LogLevel, "silent">,
    message: string,
    fields?: Record<string, unknown>,
  ) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: lvl,
      msg: redact(message),
    };
    if (fields) Object.assign(entry, redactValue(fields) as Record<string, unknown>);
    sink(JSON.stringify(entry));
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}

export const silentLogger: Logger = createLogger("silent");
