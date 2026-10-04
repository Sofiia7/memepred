from pathlib import Path
import shutil
import render_live_demo as live

live.OUT=live.ROOT/'pitch-build';live.OUT.mkdir(exist_ok=True)
live.OUTPUT_NAME='FlipTheMeme-pitch-Ava.mp4'
live.SCENES=[
 (1,0,7,'People who enjoy outcome betting want more than a handful of coins. They want a market on the meme coin they actually follow.', 'THE COIN YOU FOLLOW · THE CALL YOU WANT',None),
 (1,7,18,'FlipTheMeme brings UP or DOWN rounds to Robinhood Chain. The coin’s own on-chain pool supplies its price history, without a separately listed price feed.', 'POOL-PRICED ROUNDS ON ROBINHOOD CHAIN',None),
 (2,16,29,'Players enter in ETH with one transaction. Opposing stakes fund the payouts. Matching equal stakes keeps the promise within the round’s bank, while pool depth limits exposure.', 'ONE TRANSACTION · PLAYER-FUNDED PAYOUTS',None),
 (4,9,16,'This live founder test shows a winning DOWN position: 0.005 ETH becomes 0.0098 ETH to collect. Waiting has been cut from the recording.', 'LATER · A REAL TESTNET WINNER',(325,350,415,230)),
 (4,28,34,'The prototype includes the browser app, verified contracts and a server keeper. We also tested settlement against a real pool on a local mainnet fork.', 'WORKING PRODUCT · REPRODUCIBLE VALIDATION',None),
 (None,0,0,'Our next step is testing with independent meme-coin communities. Today this is an unaudited testnet prototype, with simulated demo prices and founder activity.', 'NEXT · INDEPENDENT COMMUNITY TESTING',None),
]
live.main()
for source,target in [('FlipTheMeme-pitch-Ava.mp4','FlipTheMeme-pitch-Ava.mp4'),('captions.srt','pitch-captions.srt'),('transcript.txt','pitch-transcript.txt'),('edit-manifest.json','pitch-edit-manifest.json')]:
    shutil.copy2(live.OUT/source,live.ROOT/'final'/target)
