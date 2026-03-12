# Contracts

These Solidity files are **starter skeletons**, not audited production contracts.

They exist to preserve the right interface boundaries:
- access control
- route execution lifecycle
- callback entry points
- explicit repayment hooks
- event-based diagnostics

## Included harnesses

- `contracts/test/RouteExecutor.t.sol` validates that the packed route plans decode and complete their lifecycle without leaving an active context behind
- `contracts/test/RouteExecutorFork.t.sol` checks that the executor can run on a fork while referencing live Ethereum protocol addresses, token metadata, and a canonical Uniswap V3 pool

## Useful commands

```bash
forge build
forge test
forge test --match-test testFork -vvvv
forge test --fork-url "$ETHEREUM_RPC_URL" --fork-block-number 18000000 -vvvv
```

The fork harness auto-skips when `FOUNDRY_FORK_URL` is not set.

Before mainnet use, add:
- full token transfer logic
- protocol-specific interfaces
- reentrancy hardening review
- callback origin validation
- allowance handling
- min-out checks
- exhaustive fork tests that assert live token state transitions
