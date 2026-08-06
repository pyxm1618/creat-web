import { redactForLogging } from "./redact";

export type LogLevel = "info" | "warn" | "error";
export type LogSink = (record: Readonly<Record<string, unknown>>) => void;

const consoleSink: LogSink = (record) => {
  console.log(JSON.stringify(record));
};

export function createLogger(base: Readonly<Record<string, unknown>> = {}, sink: LogSink = consoleSink) {
  function write(level: LogLevel, event: string, data?: unknown) {
    sink({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...((redactForLogging(base) as Record<string, unknown>) ?? {}),
      ...(data === undefined ? {} : { data: redactForLogging(data) }),
    });
  }

  return {
    info: (event: string, data?: unknown) => write("info", event, data),
    warn: (event: string, data?: unknown) => write("warn", event, data),
    error: (event: string, data?: unknown) => write("error", event, data),
  } as const;
}
