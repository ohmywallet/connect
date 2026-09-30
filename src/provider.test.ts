import { beforeEach, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { parseTransaction, stringToHex, keccak256, type TransactionSerializable } from "viem";
import { ConnectProvider } from "./provider";
const rpc = vi.hoisted(() => ({
  request: vi.fn(),
  getChainId: vi.fn(),
  estimateGas: vi.fn(),
  getTransactionCount: vi.fn(),
  getGasPrice: vi.fn(),
  estimateFeesPerGas: vi.fn(),
  getBalance: vi.fn(),
  sendRawTransaction: vi.fn(),
}));
vi.mock("viem", async (original) => ({
  ...(await original<object>()),
  createPublicClient: () => rpc,
}));
const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const other = privateKeyToAccount(`0x${"22".repeat(32)}`);
const host = { connect: vi.fn(), sign: vi.fn(), cancel: vi.fn(), destroy: vi.fn() };
let provider: ConnectProvider;
beforeEach(() => {
  vi.resetAllMocks();
  host.connect.mockResolvedValue({ address: { group: "evm", address: account.address } });
  host.sign.mockImplementation(async (request) => ({
    address: account.address,
    signature:
      request.kind === "message"
        ? await account.signMessage({ message: request.message.value })
        : request.kind === "typedData"
          ? await account.signTypedData(request.typedData)
          : await account.signTransaction(
              parseTransaction(request.serializedTransaction) as TransactionSerializable
            ),
  }));
  rpc.getChainId.mockResolvedValue(1);
  rpc.estimateGas.mockResolvedValue(21_000n);
  rpc.getTransactionCount.mockResolvedValue(0);
  rpc.estimateFeesPerGas.mockResolvedValue({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
  rpc.getBalance.mockResolvedValue(10n ** 18n);
  rpc.sendRawTransaction.mockImplementation(async ({ serializedTransaction }) =>
    keccak256(serializedTransaction)
  );
  provider = new ConnectProvider({}, host);
});
const connect = () => provider.request({ method: "eth_requestAccounts" });
const transaction = () =>
  provider.request({
    method: "eth_sendTransaction",
    params: [{ from: account.address, to: other.address, value: "0x1" }],
  });
it("starts without an account and emits account/chain lifecycle", async () => {
  const accounts = vi.fn(),
    chain = vi.fn();
  provider.on("accountsChanged", accounts).on("chainChanged", chain);
  expect(await provider.request({ method: "eth_accounts" })).toEqual([]);
  await connect();
  expect(accounts).toHaveBeenCalledWith([account.address]);
  await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x2105" }] });
  expect(chain).toHaveBeenCalledWith("0x2105");
  provider.disconnect();
  expect(await provider.request({ method: "eth_accounts" })).toEqual([]);
  provider.removeListener("chainChanged", chain);
  provider.destroy();
  await expect(connect()).rejects.toMatchObject({ code: 4900 });
});
it("requires authorization before signing", async () => {
  await expect(transaction()).rejects.toMatchObject({ code: 4100 });
  expect(host.sign).not.toHaveBeenCalled();
});
it.each(["eth_sign", "eth_sendRawTransaction", "wallet_sendCalls", "wallet_addEthereumChain"])(
  "rejects %s rather than forwarding to RPC",
  async (method) => {
    await expect(provider.request({ method })).rejects.toMatchObject({ code: 4200 });
    expect(rpc.request).not.toHaveBeenCalled();
  }
);
it("signs and independently verifies a UTF-8 message", async () => {
  await connect();
  const signature = await provider.request({
    method: "personal_sign",
    params: [stringToHex("Hello"), account.address],
  });
  expect(signature).toBe(await account.signMessage({ message: "Hello" }));
});
it("rejects another account and binary data", async () => {
  await connect();
  await expect(
    provider.request({ method: "personal_sign", params: ["0x61", other.address] })
  ).rejects.toMatchObject({ code: 4100 });
  await expect(
    provider.request({ method: "personal_sign", params: ["0xff", account.address] })
  ).rejects.toMatchObject({ code: 4200 });
  expect(host.sign).not.toHaveBeenCalled();
});
it("rejects a replaced message signature", async () => {
  await connect();
  host.sign.mockResolvedValue({
    address: account.address,
    signature: await account.signMessage({ message: "changed" }),
  });
  await expect(
    provider.request({ method: "personal_sign", params: ["0x61", account.address] })
  ).rejects.toMatchObject({ code: -32603 });
});
it("verifies typed data and rejects another domain chain", async () => {
  await connect();
  const data = {
    domain: { name: "Demo", chainId: 1 },
    types: { Mail: [{ name: "contents", type: "string" }] },
    primaryType: "Mail",
    message: { contents: "Hi" },
  } as const;
  expect(
    await provider.request({
      method: "eth_signTypedData_v4",
      params: [account.address, JSON.stringify(data)],
    })
  ).toBe(await account.signTypedData(data));
  await expect(
    provider.request({
      method: "eth_signTypedData_v4",
      params: [account.address, { ...data, domain: { chainId: 137 } }],
    })
  ).rejects.toMatchObject({ code: -32602 });
});
it("estimates, verifies and broadcasts an approved transaction", async () => {
  await connect();
  const hash = await transaction();
  const signed = rpc.sendRawTransaction.mock.calls[0]![0].serializedTransaction;
  expect(hash).toBe(keccak256(signed));
  expect(parseTransaction(signed)).toMatchObject({
    chainId: 1,
    gas: 25_200n,
    value: 1n,
    to: other.address.toLowerCase(),
  });
});
it("blocks insufficient balance including fee reserve", async () => {
  await connect();
  rpc.getBalance.mockResolvedValue(1n);
  await expect(transaction()).rejects.toMatchObject({ code: -32000 });
  expect(host.sign).not.toHaveBeenCalled();
});
it("blocks an RPC reporting the wrong chain", async () => {
  await connect();
  rpc.getChainId.mockResolvedValue(137);
  await expect(transaction()).rejects.toMatchObject({ code: 4901 });
  expect(host.sign).not.toHaveBeenCalled();
});
it.each(["value", "recipient", "chain", "signer"])(
  "rejects altered %s before broadcast",
  async (field) => {
    await connect();
    host.sign.mockImplementation(async (request) => ({
      address: account.address,
      signature: await (field === "signer" ? other : account).signTransaction({
        ...parseTransaction(request.serializedTransaction),
        ...(field === "value" ? { value: 2n } : {}),
        ...(field === "recipient" ? { to: account.address } : {}),
        ...(field === "chain" ? { chainId: 137 } : {}),
      } as TransactionSerializable),
    }));
    await expect(transaction()).rejects.toMatchObject({ code: -32603 });
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  }
);
it("disconnect during preparation prevents signing", async () => {
  await connect();
  rpc.estimateGas.mockImplementation(async () => {
    provider.disconnect();
    return 21_000n;
  });
  await expect(transaction()).rejects.toMatchObject({ code: 4001 });
  expect(host.sign).not.toHaveBeenCalled();
});
it("disconnect during approval prevents broadcast", async () => {
  await connect();
  host.sign.mockImplementation(async (request) => {
    provider.disconnect();
    return {
      address: account.address,
      signature: await account.signTransaction(
        parseTransaction(request.serializedTransaction) as TransactionSerializable
      ),
    };
  });
  await expect(transaction()).rejects.toMatchObject({ code: 4001 });
  expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
});
it("maps user rejection without leaking internal error details", async () => {
  host.connect.mockRejectedValue({ code: "USER_CANCELLED", credentialId: "secret" });
  await expect(connect()).rejects.toMatchObject({
    code: 4001,
    message: "User rejected the request",
  });
});
it("prevents simultaneous signing and chain changes", async () => {
  await connect();
  let done!: () => void;
  rpc.estimateGas.mockImplementation(
    () =>
      new Promise<bigint>((resolve) => {
        done = () => resolve(21_000n);
      })
  );
  const pending = transaction();
  await vi.waitFor(() => expect(rpc.estimateGas).toHaveBeenCalled());
  await expect(
    provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x89" }] })
  ).rejects.toMatchObject({ code: -32002 });
  done();
  await pending;
});

it("disconnect revokes the embedded grant as well as the provider account", async () => {
  const disconnect = vi.fn();
  const embedded = new ConnectProvider({}, { ...host, disconnect });
  await embedded.request({ method: "eth_requestAccounts" });
  embedded.disconnect();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(await embedded.request({ method: "eth_accounts" })).toEqual([]);
});
