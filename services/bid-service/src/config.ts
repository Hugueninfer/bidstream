import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  serviceName: string;
  grpcPort: number;
  databaseUrl: string;
  kafkaBrokers: string[];
  logLevel: string;
  otlpEndpoint: string | undefined;
  protoDir: string;
  migrationsDir: string;
}

// src/config.ts and dist/config.js sit at the same depth, so these paths work
// from sources (tests), the compiled build and the container image alike.
const here = dirname(fileURLToPath(import.meta.url));
const serviceRoot = resolve(here, '..');

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

function port(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`invalid port: ${raw}`);
  }
  return value;
}

/** proto/ is copied next to the app in the image and lives at the repo root in development. */
export function findProtoDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PROTO_DIR) return resolve(env.PROTO_DIR);
  const candidates = [resolve(serviceRoot, 'proto'), resolve(serviceRoot, '../../proto')];
  const found = candidates.find((dir) => existsSync(resolve(dir, 'bidstream/bid/v1/bid.proto')));
  if (!found) throw new Error(`proto directory not found (tried ${candidates.join(', ')}); set PROTO_DIR`);
  return found;
}

export const defaultMigrationsDir = resolve(serviceRoot, 'migrations');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    serviceName: env.OTEL_SERVICE_NAME?.trim() || 'bid-service',
    grpcPort: port(env.GRPC_PORT, 50062),
    databaseUrl: required(env, 'DATABASE_URL'),
    kafkaBrokers: required(env, 'KAFKA_BROKERS')
      .split(',')
      .map((b) => b.trim())
      .filter(Boolean),
    logLevel: env.LOG_LEVEL?.trim() || 'info',
    otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || undefined,
    protoDir: findProtoDir(env),
    migrationsDir: env.MIGRATIONS_DIR ? resolve(env.MIGRATIONS_DIR) : defaultMigrationsDir,
  };
}
