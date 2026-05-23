import { Bytes } from "@graphprotocol/graph-ts"
import { Transfer } from "../../generated/GenesisNFT/GenesisNFT"
import { GenesisToken } from "../../generated/schema"

export function handleTransfer(ev: Transfer): void {
  let id = ev.params.tokenId.toString()
  let g  = GenesisToken.load(id)
  if (g == null) {
    g = new GenesisToken(id)
    g.tokenId  = ev.params.tokenId
    g.mintedAt = ev.block.timestamp
  }
  g.owner = ev.params.to as Bytes
  g.save()
}
