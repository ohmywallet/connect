import type { IframeHostConfig } from "./types";

export type ConnectEnvironment = "production" | "development";
export const DEVELOPMENT_EMBED_ORIGIN = "https://embed.dev.ohmywallet.xyz";
export const DEVELOPMENT_CHAIN_ID = 84532;

export function connectEnvironment(value: unknown): ConnectEnvironment {
  if (value === undefined || value === "production") return "production";
  if (value === "development") return "development";
  throw new Error("Unsupported Connect environment");
}

/** Fixed environment selection is independent of the consuming application's build mode. */
export function resolveEmbedConfig(config: IframeHostConfig = {}): IframeHostConfig & {
  iframeSrc: string;
} {
  const environment = connectEnvironment(config.environment);
  if (environment === "development") {
    if (
      config.iframeSrc !== undefined ||
      config.origin !== undefined ||
      config.sandbox !== undefined
    )
      throw new Error("Development Embed endpoint, origin and sandbox are fixed");
    return { ...config, iframeSrc: DEVELOPMENT_EMBED_ORIGIN };
  }
  const iframeSrc = config.iframeSrc ?? "https://embed.ohmywallet.xyz";
  if (new URL(iframeSrc).origin === DEVELOPMENT_EMBED_ORIGIN)
    throw new Error("Select the development environment explicitly");
  // Preserve the existing root host's custom relay configuration. Custom relays
  // receive no maintained Vault permission delegation.
  return { ...config, iframeSrc };
}

export function hasInlineVaultDelegation(origin: string, config: IframeHostConfig): boolean {
  return connectEnvironment(config.environment) === "development"
    ? origin === DEVELOPMENT_EMBED_ORIGIN
    : ["https://embed.ohmywallet.xyz", "http://localhost:3122"].includes(origin);
}
