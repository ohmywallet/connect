# @ohmywallet/connect — public source snapshot

[한국어](./README.ko.md) · [Current SDK package](https://www.npmjs.com/package/@ohmywallet/connect) · [Product documentation](https://www.ohmywallet.xyz/en/#developers)

This repository currently contains the **0.6.2 source snapshot**. It may not match the latest published npm package or deployed App, Embed and Vault. Do not treat this snapshot as the complete product source or as an independent security audit. Check the version of the package you install.

## Current product architecture

For the current Connect product, the flow is dApp → Connect → Embed iframe → separate Vault window. The standalone App is not required for embedded EVM wallet connections. This describes current services, not a compatibility guarantee for the old snapshot here.

The current PRF wallet obtains secret output from WebAuthn PRF and derives signing keys in Vault JavaScript. Passkey authentication does **not** mean the derived wallet keys remain in a hardware security chip. Keys exist in browser memory during signing. Isolation, CSP and fresh authentication reduce some risks; malicious Vault code, compromised deployment/domain authority or an infected browser/device remain risks.

Recovery requires the same passkey and a PRF-compatible browser/provider. Cloud sync alone does not guarantee recovery across all devices. The product does not claim hardware-wallet-equivalent protection or a published independent audit.

See the [current security and recovery guide](https://www.ohmywallet.xyz/en/security/) and [machine-readable security model](https://www.ohmywallet.xyz/security-model.json) for current routes, supported operations and limits.

## Security reports

Please follow [SECURITY.md](./SECURITY.md). Report privately to support@ohmywallet.xyz. Never post private keys, passkey secrets or authentication tokens in an issue.

## Publishing

The legacy npm publish workflow in this snapshot is disabled. This repository must not independently publish stale source over a newer package. Publication requires the product’s separately verified release process; README updates do not publish an npm package.
