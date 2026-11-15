import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export type Config = {
  httpPort: number;
  logLevel: string;
  kafkaBrokers: string[];
  rfqServiceAddr: string;
  bidServiceAddr: string;
  pricingServiceAddr: string;
  corsOrigins: string[];
  protoDir: string;
};

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The repo's proto/ directory. In the image it is copied to /app/proto
 * (PROTO_DIR); in a checkout it sits two levels above this package.
 */
export function resolveProtoDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PROTO_DIR) return env.PROTO_DIR;
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const candidates = [path.join(packageRoot, "proto"), path.resolve(packageRoot, "../../proto")];
  return candidates.find((dir) => existsSync(path.join(dir, "bidstream"))) ?? candidates[1]!;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const httpPort = Number(env.HTTP_PORT ?? 8080);
  if (!Number.isInteger(httpPort) || httpPort <= 0) {
    throw new Error(`HTTP_PORT must be a port number, got "${env.HTTP_PORT}"`);
  }
  return {
    httpPort,
    logLevel: env.LOG_LEVEL ?? "info",
    kafkaBrokers: list(env.KAFKA_BROKERS ?? "localhost:19092"),
    rfqServiceAddr: env.RFQ_SERVICE_ADDR ?? "localhost:50061",
    bidServiceAddr: env.BID_SERVICE_ADDR ?? "localhost:50062",
    pricingServiceAddr: env.PRICING_SERVICE_ADDR ?? "localhost:50063",
    corsOrigins: list(env.CORS_ORIGINS ?? "http://localhost:5173,http://localhost:8080"),
    protoDir: resolveProtoDir(env),
  };
}
