import type { AppSignClient } from "./app-protocol";
export function memoryStorage() {
  const values = new Map<string, unknown>();
  return {
    async getKeys() {
      return [...values.keys()];
    },
    async getEntries<T>(): Promise<[string, T][]> {
      return [...values].map(([key, value]) => [key, structuredClone(value) as T]);
    },
    async getItem<T>(key: string): Promise<T | undefined> {
      return structuredClone(values.get(key)) as T | undefined;
    },
    async setItem<T>(key: string, value: T) {
      values.set(key, structuredClone(value));
    },
    async removeItem(key: string) {
      values.delete(key);
    },
    clear() {
      values.clear();
    },
  };
}
export interface AppClientOptions {
  projectId: string;
  metadata: { name: string; description: string; url: string; icons: string[] };
  storage: ReturnType<typeof memoryStorage>;
  customStoragePrefix: string;
  relayUrl: "wss://relay.walletconnect.org";
  logger: "silent";
  telemetryEnabled: false;
}
export async function createClient(options: AppClientOptions): Promise<AppSignClient> {
  const { default: SignClient } = await import("@walletconnect/sign-client");
  const client = await SignClient.init(options);
  let closed = false;
  return {
    connect: (params) => client.connect(params),
    request: (params) => client.request(params),
    disconnect: (params) => client.disconnect(params),
    session: client.session,
    on: (event, callback) => void client.on(event, callback),
    off: (event, callback) => void client.off(event, callback),
    disconnectPairing: (topic) => client.core.pairing.disconnect({ topic }),
    async close() {
      if (closed) return;
      closed = true;
      options.storage.clear();
      client.core.heartbeat.stop();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          client.core.relayer.transportClose(),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 5_000);
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
