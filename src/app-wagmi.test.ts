import { beforeEach, expect, it, vi } from "vitest";
import {
  connect,
  createConfig,
  disconnect,
  getConnection,
  reconnect,
  signMessage,
  signTypedData,
  switchChain,
} from "@wagmi/core";
import { http } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { ohmywalletApp } from "./app-wagmi";
import type { AppProviderOptions } from "./app";

const fixture = vi.hoisted(() => ({
  factory: vi.fn(),
  authenticate: vi.fn(),
  providers: [] as TestAppProvider[],
}));
vi.mock("./app", () => ({
  createAppProvider: (options: AppProviderOptions) => fixture.factory(options),
}));

const account = "0x1111111111111111111111111111111111111111";
// A contract-wallet signature is not an EOA's fixed 65-byte signature.
const contractSignature = `0x${"ab".repeat(256)}`;
const options: AppProviderOptions = {
  projectId: "synthetic-project-id",
  metadata: { name: "Synthetic integration" },
  locale: "en",
};

class TestAppProvider {
  private authorized = false;
  private destroyed = false;
  private readonly listeners = new Map<string, Set<(value: unknown) => void>>();
  readonly request = vi.fn(async ({ method }: { method: string; params?: unknown }) => {
    if (method === "eth_accounts") return this.authorized ? [account] : [];
    if (method === "eth_chainId") return `0x${this.options.chainId!.toString(16)}`;
    if (method === "eth_requestAccounts") {
      const selected = await fixture.authenticate();
      this.authorized = true;
      this.emit("accountsChanged", selected);
      return selected;
    }
    if (method === "personal_sign" || method === "eth_signTypedData_v4") return contractSignature;
    throw Object.assign(new Error("Unsupported method"), { code: 4200 });
  });
  readonly disconnect = vi.fn(async () => {
    this.authorized = false;
    this.emit("accountsChanged", []);
  });
  readonly destroy = vi.fn(() => {
    if (this.destroyed) return;
    this.destroyed = true;
    this.authorized = false;
    this.emit("disconnect", { code: 4900 });
  });

  constructor(readonly options: AppProviderOptions) {}

  on(event: string, listener: (value: unknown) => void) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }
  removeListener(event: string, listener: (value: unknown) => void) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }
  emit(event: string, value: unknown) {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
  get listenerCount() {
    return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0);
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  fixture.providers = [];
  fixture.authenticate.mockResolvedValue([account]);
  fixture.factory.mockImplementation((selected: AppProviderOptions) => {
    const provider = new TestAppProvider(selected);
    fixture.providers.push(provider);
    return provider;
  });
});

function setup() {
  const config = createConfig({
    chains: [mainnet, sepolia],
    connectors: [ohmywalletApp(options)],
    transports: { [mainnet.id]: http(), [sepolia.id]: http() },
    storage: null,
    multiInjectedProviderDiscovery: false,
  });
  return { config, connector: config.connectors[0]! };
}

it("does not authenticate or restore accounts on config creation or reconnect", async () => {
  const { config, connector } = setup();
  expect(connector.id).toBe("ohmywallet-app");
  expect(connector.name).toBe("OhMyWallet App");
  expect(await connector.getAccounts()).toEqual([]);
  expect(await connector.isAuthorized()).toBe(false);
  expect(fixture.factory).not.toHaveBeenCalled();
  expect(await reconnect(config)).toEqual([]);
  // wagmi may obtain a lazy Provider to discover the connector; construction is not connection.
  await expect(connector.connect({ isReconnecting: true })).rejects.toMatchObject({ code: 4100 });
  expect(getConnection(config).status).toBe("disconnected");
  expect(
    fixture.providers
      .flatMap((provider) => provider.request.mock.calls)
      .some(([request]) => request.method === "eth_requestAccounts")
  ).toBe(false);
  expect(fixture.authenticate).not.toHaveBeenCalled();
});

it("selects the requested configured chain before connecting and preserves contract-wallet signatures through wagmi", async () => {
  const { config, connector } = setup();
  await connect(config, { connector, chainId: sepolia.id });
  expect(fixture.factory).toHaveBeenCalledExactlyOnceWith({ ...options, chainId: sepolia.id });
  expect(getConnection(config).address).toBe(account);
  expect(getConnection(config).chainId).toBe(sepolia.id);
  const signature = await signMessage(config, { message: "No asset authorization" });
  expect(signature).toBe(contractSignature);
  expect(
    fixture.providers[0]!.request.mock.calls.find(
      ([request]) => request.method === "personal_sign"
    )?.[0]
  ).toEqual({
    method: "personal_sign",
    params: ["0x4e6f20617373657420617574686f72697a6174696f6e", account],
  });
  expect(
    await signTypedData(config, {
      domain: { name: "Test", chainId: sepolia.id },
      types: { Test: [{ name: "value", type: "string" }] },
      primaryType: "Test",
      message: { value: "No asset authorization" },
    })
  ).toBe(contractSignature);
  expect(
    fixture.providers[0]!.request.mock.calls.some(
      ([request]) => request.method === "eth_signTypedData_v4"
    )
  ).toBe(true);
  await disconnect(config);
  expect(getConnection(config).status).toBe("disconnected");
  expect(fixture.providers[0]!.disconnect).toHaveBeenCalledOnce();
  expect(fixture.providers[0]!.destroy).toHaveBeenCalledOnce();
  expect(fixture.providers[0]!.listenerCount).toBe(0);
});

it("requires explicit disconnect before choosing another chain and does not claim a local-only chain switch", async () => {
  const { config, connector } = setup();
  await connect(config, { connector });
  const active = fixture.providers[0]!;
  await expect(switchChain(config, { chainId: sepolia.id })).rejects.toMatchObject({ code: 4200 });
  await expect(connector.connect({ chainId: sepolia.id })).rejects.toMatchObject({ code: 4200 });
  expect(getConnection(config).chainId).toBe(mainnet.id);
  expect(getConnection(config).address).toBe(account);
  expect(active.disconnect).not.toHaveBeenCalled();
  expect(fixture.factory).toHaveBeenCalledOnce();
  expect(
    active.request.mock.calls.some(([request]) => request.method === "wallet_switchEthereumChain")
  ).toBe(false);
  await disconnect(config);
  await connect(config, { connector, chainId: sepolia.id });
  expect(getConnection(config).chainId).toBe(sepolia.id);
  expect(fixture.providers[1]!.options.chainId).toBe(sepolia.id);
  await disconnect(config);
});

it("rejects an unconfigured chain without opening App and preserves wallet rejection codes", async () => {
  const { config, connector } = setup();
  await expect(connector.connect({ chainId: 56 })).rejects.toMatchObject({ code: 4902 });
  expect(fixture.factory).not.toHaveBeenCalled();
  fixture.authenticate.mockRejectedValueOnce(Object.assign(new Error("Declined"), { code: 4001 }));
  await expect(connect(config, { connector })).rejects.toMatchObject({ code: 4001 });
  expect(getConnection(config).status).toBe("disconnected");
  expect(fixture.providers[0]!.destroy).toHaveBeenCalledOnce();
  expect(fixture.providers[0]!.listenerCount).toBe(0);
});

it("does not resurrect an old connection or disturb a new one after cancellation and late approval", async () => {
  const { config, connector } = setup();
  let resolve!: (accounts: readonly string[]) => void;
  fixture.authenticate.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  const stale = connect(config, { connector }).catch((error: unknown) => error);
  await vi.waitFor(() => expect(fixture.authenticate).toHaveBeenCalledOnce());
  await connector.disconnect();
  await connect(config, { connector, chainId: sepolia.id });
  resolve([account]);
  expect(await stale).toMatchObject({ code: 4001 });
  expect(getConnection(config).chainId).toBe(sepolia.id);
  expect(getConnection(config).address).toBe(account);
  expect(fixture.providers[1]!.destroy).not.toHaveBeenCalled();
  await disconnect(config);
});

it("propagates session account loss and rejects a cross-chain event instead of widening the session", async () => {
  const { config, connector } = setup();
  await connect(config, { connector });
  fixture.providers[0]!.emit("accountsChanged", []);
  expect(getConnection(config).status).toBe("disconnected");
  expect(fixture.providers[0]!.listenerCount).toBe(0);
  await connect(config, { connector });
  fixture.providers[1]!.emit("chainChanged", "0xaa36a7");
  expect(getConnection(config).status).toBe("disconnected");
  expect(fixture.providers[1]!.listenerCount).toBe(0);
  expect(await connector.isAuthorized()).toBe(false);
});
