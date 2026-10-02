# Robinhood Chain Rounds: demo script

The ready-to-upload video is [`artifacts/hackquest-demo/flipthememe-hackquest-demo.mp4`](../../artifacts/hackquest-demo/flipthememe-hackquest-demo.mp4). It uses Ava neural narration. Its captions and transcript keep token names intact, including WETH. The video uses illustrations for the public ETH flow and labels the current-contract scripted WETH run separately; it does **not** claim a browser-wallet wager.

## If recording a fresh live browser walkthrough

1. Open [the public desktop Rounds page](https://rhc.flipthememe.com/rounds). Show the three listed test pools and the Robinhood Chain testnet indicator. These pools have scripted prices; say so.
2. Open one pool. Show its depth gate, public UP/DOWN totals, round timeline and the risk disclosure. Explain that the strike is set after betting closes, so the bet is on the later move.
3. Connect a wallet holding test ETH. Stake at least 0.005 ETH on one side. The current contract accepts ETH in one wallet transaction; no swap, separate wrap or token approval is needed. A second wallet must place at least 0.005 ETH on the opposite side for the 0.01 ETH matched-bank activation threshold.
4. Show the round's actual timestamps. If recording settlement, keep the 11-minute wait after betting closes honest with a visible time jump. The keeper fixes the strike and settles after the exit window. Show the ticket, `Collect ETH` and the transaction on the explorer. Do not script a win before its outcome is known.
5. Show the [current verified PoolRounds contract](https://explorer.testnet.chain.robinhood.com/address/0x1e928adc9de612b08f78824417d4f5ef354c66d7) and [keeper health](https://api-rhc.flipthememe.com/api/rounds/health). The [current-contract scripted WETH run](measurements/rounds/e2e-testnet-60s.log) and [local mainnet fork](measurements/rounds/mainnet-fork-2026-10-01.md) are separately labeled evidence, not browser transactions on the public ETH entry path.

If no fresh live round is available, use the existing video and its precise evidence labels. A fully recorded new-deployment ETH wager and settlement remains an open verification item.
