import type { Address } from 'viem'

// The 2 October contract switch did not move tickets or their ETH. A player
// can still collect an unmatched stake directly from this deployment.
export const PREVIOUS_ROUNDS: { address: Address; deployBlock: bigint } = {
  address: '0xb70fa41f1ad30235ff580c33e76f3490272bcd97',
  deployBlock: 127475141n,
}
