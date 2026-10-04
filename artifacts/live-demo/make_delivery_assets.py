from pathlib import Path
from PIL import Image, ImageDraw
ROOT=Path(__file__).parent/'final'
# Raster export of the existing CSS brand mark, with exactly the same bolt polygon.
image=Image.new('RGB',(512,512),'#080a06');d=ImageDraw.Draw(image)
d.rounded_rectangle((48,48,464,464),radius=54,fill='#ccff00')
inset=96;span=320
points=[(.55,0),(1,0),(.45,.5),(.9,.5),(0,1),(.55,.5),(.1,.5)]
d.polygon([(inset+x*span,inset+y*span) for x,y in points],fill='#101309')
image.save(ROOT/'project-logo.png')
(ROOT/'description.md').write_text('''# FlipTheMeme — live browser demo

Recorded by the founder on 4 October 2026; edited with Ava neural English narration.

The demo shows two founder wallets staking 0.005 ETH on opposite sides of FROGGO, a DOWN result, and collection of 0.0098 native ETH. Waiting and unsuccessful UI attempts were removed. A "Later" chapter marks the settlement time jump. Payouts and wallet interactions are recorded footage, not illustrations.

The interface was refined after recording: My bets now has a dedicated page, sharing has only X and Copy link, and the strike chart's display orientation was corrected. The recording includes a round on an earlier demo pool; this pool no longer takes new bets. The same PoolRounds contract remains active with three replacement continuous demo pools.

This is an unaudited Robinhood Chain testnet prototype (chain ID 46630). Prices are simulated and predictable, and activity is founder testing. No organic user demand or mainnet betting is claimed.

Demo: https://rhc.flipthememe.com/rounds
My bets: https://rhc.flipthememe.com/bets
Verified contract: https://explorer.testnet.chain.robinhood.com/address/0x1e928adc9de612b08f78824417d4f5ef354c66d7
Keeper health: https://api-rhc.flipthememe.com/api/rounds/health
Source: https://github.com/Sofiia7/memepred/tree/robinhood-chain

Use FlipTheMeme-live-demo-Ava.mp4 for Demo Video, and FlipTheMeme-pitch-Ava.mp4 for Pitch Video. The clean English SRT captions and transcripts are included separately. The edit manifests identify source recordings, intervals and narration for review.
''',encoding='utf-8')
