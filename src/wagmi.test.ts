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
import { http, verifyMessage } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { ohmywallet } from "./wagmi";
import { ConnectProvider } from "./provider";
const fixture = vi.hoisted(() => ({ factory: vi.fn() }));
vi.mock("./provider", async (original) => ({
  ...(await original<object>()),
  createProvider: (options: unknown) => fixture.factory(options),
}));
const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const host = { connect: vi.fn(), sign: vi.fn(), cancel: vi.fn(), destroy: vi.fn() };
beforeEach(() => {
  vi.resetAllMocks();
  host.connect.mockResolvedValue({ address: { group: "evm", address: account.address } });
  host.sign.mockImplementation(async (request) => ({
    address: account.address,
    signature:
      request.kind === "message"
        ? await account.signMessage({ message: request.message.value })
        : await account.signTypedData(request.typedData),
  }));
  fixture.factory.mockImplementation((options) => new ConnectProvider(options, host));
});
function setup() {
  const config = createConfig({
    chains: [mainnet, sepolia],
    connectors: [ohmywallet()],
    transports: { 1: http(), 11155111: http() },
    storage: null,
    multiInjectedProviderDiscovery: false,
  });
  return { config, connector: config.connectors[0]! };
}
it("does not authenticate on setup or reconnect after a page reload", async () => {
  const { config } = setup();
  expect(fixture.factory).not.toHaveBeenCalled();
  expect(await reconnect(config)).toEqual([]);
  expect(host.connect).not.toHaveBeenCalled();
  expect(getConnection(config).status).toBe("disconnected");
});
it("supports real wagmi connection, signatures, chain changes and disconnect", async () => {
  const { config, connector } = setup();
  await connect(config, { connector });
  expect(getConnection(config).address).toBe(account.address);
  const signature = await signMessage(config, { message: "wagmi integration test" });
  expect(
    await verifyMessage({ address: account.address, message: "wagmi integration test", signature })
  ).toBe(true);
  await switchChain(config, { chainId: sepolia.id });
  expect(getConnection(config).chainId).toBe(sepolia.id);
  await signTypedData(config, {
    domain: { name: "Test", chainId: sepolia.id },
    types: { Test: [{ name: "value", type: "string" }] },
    primaryType: "Test",
    message: { value: "No asset authorization" },
  });
  await disconnect(config);
  expect(getConnection(config).status).toBe("disconnected");
  expect(await connector.isAuthorized()).toBe(false);
  expect(host.destroy).toHaveBeenCalledOnce();
  await connect(config, { connector });
  expect(host.connect).toHaveBeenCalledTimes(2);
  await disconnect(config);
});
it("preserves rejection and prevents switching to an unconfigured chain", async () => {
  const { config, connector } = setup();
  host.connect.mockRejectedValueOnce({ code: "USER_CANCELLED" });
  await expect(connect(config, { connector })).rejects.toMatchObject({ code: 4001 });
  expect(getConnection(config).status).toBe("disconnected");
  await expect(connector.switchChain!({ chainId: 56 })).rejects.toMatchObject({ code: 4902 });
  expect(host.connect).toHaveBeenCalledOnce();
});
it("does not resurrect a pending connection after disconnect", async () => {
  const { config, connector } = setup();
  let resolve!: (value: unknown) => void;
  host.connect.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  const pending = connect(config, { connector });
  await vi.waitFor(() => expect(host.connect).toHaveBeenCalled());
  await connector.disconnect();
  resolve({ address: { group: "evm", address: account.address } });
  await expect(pending).rejects.toMatchObject({ code: 4001 });
  expect(getConnection(config).status).toBe("disconnected");
});
it("propagates provider account loss to wagmi", async () => {
  const { config, connector } = setup();
  await connect(config, { connector });
  (await connector.getProvider()).disconnect();
  expect(getConnection(config).status).toBe("disconnected");
  await connector.disconnect();
});

it("replaces a destroyed provider before connecting again", async () => {
  const { config, connector } = setup();
  await connect(config, { connector });
  (await connector.getProvider()).destroy();
  expect(getConnection(config).status).toBe("disconnected");
  await connect(config, { connector });
  expect(getConnection(config).address).toBe(account.address);
  expect(fixture.factory).toHaveBeenCalledTimes(2);
  await disconnect(config);
});
