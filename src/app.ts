import { AppProviderRuntime } from "./app-provider";
import type {
  AppProviderOptions,
  AppProviderState,
  AppProviderEvent,
  AppProviderListener,
} from "./app-types";
export type { AppProviderOptions, AppProviderState, AppPairing } from "./app-types";
export { AppProviderRpcError } from "./app-types";
export { APP_CHAIN_IDS } from "./app-protocol";

/** Explicit App WalletConnect adapter. Constructing it never restores or connects a wallet. */
export class AppProvider {
  readonly #runtime: AppProviderRuntime;
  constructor(options: AppProviderOptions) {
    this.#runtime = new AppProviderRuntime(options);
  }
  get currentState(): AppProviderState {
    return this.#runtime.currentState;
  }
  request(args: { method: string; params?: readonly unknown[] | object }): Promise<unknown> {
    return this.#runtime.request(args);
  }
  on(event: "stateChanged", listener: (state: AppProviderState) => void): this;
  on(event: AppProviderEvent, listener: AppProviderListener): this;
  on(
    event: AppProviderEvent,
    listener: AppProviderListener | ((state: AppProviderState) => void)
  ): this {
    this.#runtime.on(event, listener as AppProviderListener);
    return this;
  }
  removeListener(event: "stateChanged", listener: (state: AppProviderState) => void): this;
  removeListener(event: AppProviderEvent, listener: AppProviderListener): this;
  removeListener(
    event: AppProviderEvent,
    listener: AppProviderListener | ((state: AppProviderState) => void)
  ): this {
    this.#runtime.removeListener(event, listener as AppProviderListener);
    return this;
  }
  cancel(): boolean {
    return this.#runtime.cancel();
  }
  disconnect(): Promise<void> {
    return this.#runtime.disconnect();
  }
  destroy(): void {
    this.#runtime.destroy();
  }
}
export function createAppProvider(options: AppProviderOptions): AppProvider {
  return new AppProvider(options);
}
