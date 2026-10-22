import { createConnector } from "@wagmi/core";
import { getAddress, type Address } from "viem";
import { createAppProvider, type AppProvider, type AppProviderOptions } from "./app";

const rpcError = (code: number, message: string) => Object.assign(new Error(message), { code });

/** App sessions are explicit and single-chain. Config creation and reconnect never open a wallet. */
export function ohmywalletApp(options: AppProviderOptions) {
  return createConnector<AppProvider>((config) => {
    let provider: AppProvider | undefined;
    let providerChain: number | undefined;
    let generation = 0;
    let connecting: number | undefined;

    const accounts = (value: unknown): readonly Address[] => {
      if (!Array.isArray(value) || value.length > 1) throw rpcError(-32603, "Invalid App accounts");
      try {
        return value.map((item) => getAddress(item));
      } catch {
        throw rpcError(-32603, "Invalid App accounts");
      }
    };
    const accountChanged = (value: unknown) => {
      if (connecting !== undefined) return;
      const selected = accounts(value);
      if (selected.length === 0) disconnected();
      else config.emitter.emit("change", { accounts: selected });
    };
    const chainChanged = (value: unknown) => {
      if (connecting !== undefined) return;
      // A single-chain session must never be widened by a provider event.
      if (value !== `0x${providerChain?.toString(16)}`) disconnected();
    };
    const disconnected = () => {
      ++generation;
      connecting = undefined;
      detach()?.destroy();
      config.emitter.emit("disconnect");
    };
    function detach() {
      const active = provider;
      provider = undefined;
      providerChain = undefined;
      active?.removeListener("accountsChanged", accountChanged);
      active?.removeListener("chainChanged", chainChanged);
      active?.removeListener("disconnect", disconnected);
      return active;
    }
    async function release() {
      const active = detach();
      if (!active) return;
      try {
        await active.disconnect();
      } finally {
        active.destroy();
      }
    }
    function getProvider(chainId = options.chainId ?? config.chains[0].id) {
      if (!provider) {
        if (!config.chains.some((chain) => chain.id === chainId))
          throw rpcError(4902, "Chain not configured");
        const active = createAppProvider({ ...options, chainId });
        provider = active;
        providerChain = chainId;
        active.on("accountsChanged", accountChanged);
        active.on("chainChanged", chainChanged);
        active.on("disconnect", disconnected);
      }
      return provider;
    }

    return {
      id: "ohmywallet-app",
      name: "OhMyWallet App",
      type: "ohmywallet-app",
      async connect({ chainId, isReconnecting, withCapabilities } = {}) {
        if (connecting !== undefined) throw rpcError(-32002, "Connection already pending");
        const requestedChain = chainId ?? providerChain ?? options.chainId ?? config.chains[0].id;
        if (!config.chains.some((chain) => chain.id === requestedChain))
          throw rpcError(4902, "Chain not configured");
        const version = ++generation;
        connecting = version;
        let active: AppProvider | undefined;
        const current = () => {
          if (version !== generation) throw rpcError(4001, "Connection cancelled");
        };
        try {
          if (provider && providerChain !== requestedChain) {
            const existing = accounts(await provider.request({ method: "eth_accounts" }));
            current();
            if (existing.length)
              throw rpcError(4200, "Disconnect and reconnect to choose another App network");
            await release();
            current();
          }
          active = getProvider(requestedChain);
          const selected = accounts(
            await active.request({
              method: isReconnecting ? "eth_accounts" : "eth_requestAccounts",
            })
          );
          current();
          if (!selected.length) throw rpcError(4100, "Connect an App account first");
          const actualChain = await active.request({ method: "eth_chainId" });
          current();
          if (actualChain !== `0x${requestedChain.toString(16)}`)
            throw rpcError(4901, "App session chain mismatch");
          return {
            accounts: (withCapabilities
              ? selected.map((address) => ({ address, capabilities: {} }))
              : selected) as never,
            chainId: requestedChain,
          };
        } catch (error) {
          if (version === generation && active && provider === active) {
            try {
              await release();
            } catch {
              // Preserve the request's rejection after best-effort transport cleanup.
            }
          }
          throw error;
        } finally {
          if (connecting === version) connecting = undefined;
        }
      },
      async disconnect() {
        ++generation;
        connecting = undefined;
        await release();
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
        if (!chain) throw rpcError(4902, "Chain not configured");
        const activeChain = providerChain ?? options.chainId ?? config.chains[0].id;
        if (chainId !== activeChain)
          throw rpcError(4200, "Disconnect and reconnect to choose another App network");
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
