# Security policy

## Report privately

Send security reports to **support@ohmywallet.xyz**, with subject `Security report`.
Do not open a public issue containing an exploitable vulnerability or user information.
Include the affected URL, date, browser/version, expected behavior and a minimal reproduction using synthetic data or your own empty test wallet.
Never send passkeys, PRF output, seeds, private keys, authentication tokens or real signed transactions.

Do not test other users, transfer assets, collect credentials, disrupt service or probe provider accounts. No bug bounty, payment, legal safe harbor or response-time guarantee is offered by this policy.

## Scope and current evidence

- Current PRF-v2 wallet: https://www.ohmywallet.xyz/en/security/
- Machine-readable architecture: https://www.ohmywallet.xyz/security-model.json
- Risk disclosure: https://www.ohmywallet.xyz/en/risk/
- Public Connect repository: https://github.com/ohmywallet/connect

The full product repository is private. The public Connect repository is a separate snapshot; inspect its version and commit before treating it as deployed product source. Public bundles are not an independent audit or proof of code integrity.

PRF signing keys exist in Vault JavaScript memory during use. This is a software hot wallet, not hardware-wallet-equivalent protection. Deployment, domain, browser and device compromise remain trust risks. No independent audit report is currently published.
