## Foundry

**Foundry is a blazing fast, portable and modular toolkit for Ethereum application development written in Rust.**

Foundry consists of:

- **Forge**: Ethereum testing framework (like Truffle, Hardhat and DappTools).
- **Cast**: Swiss army knife for interacting with EVM smart contracts, sending transactions and getting chain data.
- **Anvil**: Local Ethereum node, akin to Ganache, Hardhat Network.
- **Chisel**: Fast, utilitarian, and verbose solidity REPL.

## Documentation

https://book.getfoundry.sh/

## Usage

### Build

```shell
$ forge build
```

### Test

```shell
$ forge test
```

`test/PoolOracleResolverFork.t.sol` and `test/PoolRingCostFork.t.sol` (11 test
functions between them) fork Robinhood Chain mainnet and need `RHC_MAINNET_RPC`
set to a real archive RPC URL. Without it, each test hits
`vm.envOr("RHC_MAINNET_RPC", string(""))`, sees an empty string, and returns
immediately with zero assertions run - `forge test` reports them as PASS
either way, so a green run does not by itself mean fork behavior was
exercised. Check the test output for what actually ran, e.g.:

```shell
$ RHC_MAINNET_RPC=https://your-archive-node forge test -vv
```

In CI, `RHC_MAINNET_RPC` is wired into the `contracts` job as an optional
secret (`.github/workflows/ci.yml`) but is not currently configured in this
repo's GitHub settings, so these 11 tests are vacuous on every CI run today.

### Format

```shell
$ forge fmt
```

### Gas Snapshots

```shell
$ forge snapshot
```

### Anvil

```shell
$ anvil
```

### Deploy

```shell
$ forge script script/Counter.s.sol:CounterScript --rpc-url <your_rpc_url> --private-key <your_private_key>
```

### Cast

```shell
$ cast <subcommand>
```

### Help

```shell
$ forge --help
$ anvil --help
$ cast --help
```
