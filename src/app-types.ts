import type { SupportedLocale } from "./types";

/** App connection is opt-in. The existing Embed provider remains independent. */
export interface AppProviderOptions {
  /** Explicit account intent. Omission keeps the published managed App handoff unchanged. */
  account?: "managed" | "fee";
  projectId: string;
  chainId?: number;
  metadata: { name: string; description?: string; icons?: readonly string[] };
  locale?: SupportedLocale;
}
export interface AppPairing {
  readonly uri: string;
  readonly appUrl: string;
  readonly expiresAt: number;
}
export interface AppProviderState {
  readonly status: "idle" | "connecting" | "pairing" | "connected" | "closed";
  readonly chainId: number;
  readonly address?: string;
  readonly busy: boolean;
  readonly pairing?: AppPairing;
}
export type AppProviderEvent =
  "accountsChanged" | "chainChanged" | "connect" | "disconnect" | "stateChanged";
export type AppProviderListener = (value: unknown) => void;
export class AppProviderRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly reason?: "expired"
  ) {
    super(message);
    this.name = "AppProviderRpcError";
  }
}
