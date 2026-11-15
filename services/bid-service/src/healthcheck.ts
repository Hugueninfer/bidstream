// Container HEALTHCHECK: exits 0 when grpc.health.v1 reports SERVING.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { protoPath } from 'grpc-health-check';

interface HealthClient extends grpc.Client {
  Check(
    request: { service: string },
    options: grpc.CallOptions,
    callback: (err: grpc.ServiceError | null, response?: { status: string }) => void,
  ): void;
}

const port = process.env.GRPC_PORT ?? '50062';
const definition = protoLoader.loadSync(protoPath, { keepCase: true, enums: String, defaults: true });
const { grpc: g } = grpc.loadPackageDefinition(definition) as unknown as {
  grpc: { health: { v1: { Health: new (address: string, creds: grpc.ChannelCredentials) => HealthClient } } };
};
const client = new g.health.v1.Health(`127.0.0.1:${port}`, grpc.credentials.createInsecure());

client.Check({ service: '' }, { deadline: Date.now() + 2_000 }, (err, response) => {
  client.close();
  process.exit(!err && response?.status === 'SERVING' ? 0 : 1);
});
