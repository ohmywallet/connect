import { createConnector } from "@wagmi/core";
import { getAddress, type Address } from "viem";
import {
  createProvider,
  ProviderRpcError,
  type ConnectProvider,
  type ConnectProviderOptions,
} from "./provider";

/** Optional wagmi entry point. Creating config never authenticates or restores a passkey. */
export function ohmywallet(options: ConnectProviderOptions = {}) {
  return createConnector<ConnectProvider>((config) => {
    let provider: ConnectProvider | undefined;
    let connecting = false;
    let generation = 0;
    const accounts = (value: unknown): readonly Address[] => {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
        throw new ProviderRpcError(-32603, "Invalid accounts");
      return value.map((item) => getAddress(item));
    };
    const accountChanged = (value: unknown) => {
      if (connecting) return;
      const selected = accounts(value);
      if (!selected.length) {
        ++generation;
        config.emitter.emit("disconnect");
      } else config.emitter.emit("change", { accounts: selected });
    };
    const chainChanged = (value: unknown) => {
      if (connecting) return;
      if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return;
      const chainId = Number(BigInt(value));
      if (Number.isSafeInteger(chainId)) config.emitter.emit("change", { chainId });
    };
    const disconnected = () => {
      ++generation;
      release();
      config.emitter.emit("disconnect");
    };
    function release() {
      const active = provider;
      provider = undefined;
      active?.removeListener("accountsChanged", accountChanged);
      active?.removeListener("chainChanged", chainChanged);
      active?.removeListener("disconnect", disconnected);
      active?.destroy();
    }
    function getProvider() {
      if (!provider) {
        const chainId = options.chainId ?? config.chains[0].id;
        if (!config.chains.some((chain) => chain.id === chainId))
          throw new ProviderRpcError(4902, "Chain not configured");
        provider = createProvider({ ...options, chainId });
        provider
          .on("accountsChanged", accountChanged)
          .on("chainChanged", chainChanged)
          .on("disconnect", disconnected);
      }
      return provider;
    }
    return {
      id: "ohmywallet",
      name: "OhMyWallet",
      type: "ohmywallet",
      async connect({ chainId, isReconnecting, withCapabilities } = {}) {
        if (connecting) throw new ProviderRpcError(-32002, "Connection already pending");
        if (chainId !== undefined && !config.chains.some((chain) => chain.id === chainId))
          throw new ProviderRpcError(4902, "Chain not configured");
        const active = getProvider();
        const version = ++generation;
        connecting = true;
        try {
          // A wagmi reconnect may inspect this session, but must never open authentication UI.
          const selected = accounts(
            await active.request({
              method: isReconnecting ? "eth_accounts" : "eth_requestAccounts",
            })
          );
          if (!selected.length) throw new ProviderRpcError(4100, "Connect an account first");
          if (version !== generation) throw new ProviderRpcError(4001, "Connection cancelled");
          let currentChain = Number(
            BigInt((await active.request({ method: "eth_chainId" })) as string)
          );
          if (chainId !== undefined && chainId !== currentChain) {
            await active.request({
              method: "wallet_switchEthereumChain",
              params: [{ chainId: `0x${chainId.toString(16)}` }],
            });
            currentChain = chainId;
          }
          if (version !== generation) throw new ProviderRpcError(4001, "Connection cancelled");
          return {
            accounts: (withCapabilities
              ? selected.map((address) => ({ address, capabilities: {} }))
              : selected) as never,
            chainId: currentChain,
          };
        } catch (error) {
          if (version === generation) release();
          throw error;
        } finally {
          connecting = false;
        }
      },
      async disconnect() {
        ++generation;
        release();
      },
      async getProvider() {
        return getProvider();
      },
      async getAccounts() {
        return provider ? accounts(await provider.request({ method: "eth_accounts" })) : [];
      },
      async getChainId() {
        return Number(BigInt((await getProvider().request({ method: "eth_chainId" })) as string));
      },
      async isAuthorized() {
        return provider !== undefined && (await this.getAccounts()).length > 0;
      },
      async switchChain({ chainId }) {
        const chain = config.chains.find((item) => item.id === chainId);
        if (!chain) throw new ProviderRpcError(4902, "Chain not configured");
        await getProvider().request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: `0x${chainId.toString(16)}` }],
        });
        return chain;
      },
      onAccountsChanged(value) {
        accountChanged(value);
      },
      onChainChanged(value) {
        chainChanged(value);
      },
      onDisconnect() {
        disconnected();
      },
    };
  });
}
