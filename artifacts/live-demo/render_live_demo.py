"""Reproducible edit of Sofia's original browser recordings; originals stay untouched."""
from pathlib import Path
import asyncio, json, subprocess, wave, hashlib
import aiohttp, edge_tts, imageio_ffmpeg
from PIL import Image, ImageDraw, ImageFont

aiohttp.connector.DefaultResolver = aiohttp.resolver.ThreadedResolver
ROOT=Path(__file__).parent
OUT=ROOT/'final'; OUT.mkdir(exist_ok=True)
FF=imageio_ffmpeg.get_ffmpeg_exe()
FILES=sorted(ROOT.glob('Запись*.mp4'))
VOICE='en-US-AvaNeural'
OUTPUT_NAME='FlipTheMeme-live-demo-Ava.mp4'
W,H=1920,1080
# recording (1-based), source start/end, caption/narration, chapter, optional crop.
SCENES=[
 (1,0,7,'FlipTheMeme brings short UP or DOWN rounds on meme coins to Robinhood Chain.', 'FLIPTHEMEME · LIVE BROWSER DEMO',None),
 (1,7,18,'For people who enjoy outcome betting, this is a way to call a meme coin’s next move without buying or shorting it.', 'CHOOSE A COIN AND A SIDE',None),
 (1,18,24,'This is a testnet prototype. The demo pools use simulated prices, and every stake uses test ETH.', 'ROBINHOOD CHAIN TESTNET · SIMULATED PRICES',None),
 (2,6,13,'First, connect the browser wallet. This recording uses two founder wallets to demonstrate both sides of one round.', 'CONNECT WALLET',None),
 (2,16,29,'The first wallet stakes 0.005 ETH on UP. One transaction is enough: the contract wraps ETH internally, so there is no separate swap or approval.', 'WALLET ONE · UP · 0.005 ETH',None),
 (3,53,64,'The second wallet takes DOWN with another 0.005 ETH. Both sides fund the round; the protocol does not need a house bankroll.', 'WALLET TWO · DOWN · 0.005 ETH',None),
 (3,66.5,70.2,'Confirm the DOWN transaction in the wallet.', 'CONFIRM THE OPPOSITE SIDE',None),
 (3,79,85.5,'A new betting round opens every five minutes. An active round finishes sixteen minutes after opening, rather than immediately after the click.', 'ROUND TIMING · WAITING SHORTENED IN THIS EDIT',None),
 (4,0,5,'The result compares a future strike average with the exit price. Movement before that strike does not decide the outcome.', 'LATER · AFTER THE STRIKE AND EXIT',(325,414,415,185)),
 (4,9,16,'In this recorded round, DOWN won. The winning 0.005 ETH stake can collect 0.0098 ETH: a 1.96 times payout.', 'ACTUAL RESULT · DOWN WON · 1.96×',(325,350,415,230)),
 (4,24,26.8,'Press Collect and confirm the transaction to receive the payout in native ETH.', 'COLLECT THE WINNINGS',(1520,0,398,810)),
 (4,28,34,'The position now shows Collected: 0.0098 ETH. This is a real testnet transaction, shown in the live browser recording.', 'PAYOUT COLLECTED · 0.0098 ETH',None),
 (None,0,0,'FlipTheMeme is a working, unaudited testnet prototype. Try the rounds, inspect the verified contract, and explore the source code.', 'TRY FLIPTHEMEME',None),
]

def run(args):
    subprocess.run([FF,'-y','-v','error',*args],check=True)

def font(size,bold=False):
    return ImageFont.truetype('C:/Windows/Fonts/'+('arialbd.ttf' if bold else 'arial.ttf'),size)

def wrap(draw,text,f,width):
    lines=[];line=''
    for word in text.split():
        trial=(line+' '+word).strip()
        if draw.textlength(trial,font=f)>width and line: lines.append(line);line=word
        else: line=trial
    if line: lines.append(line)
    return lines

async def voice_one(text,sem):
    p=OUT/('ava-'+hashlib.sha256(text.encode()).hexdigest()[:12]+'.mp3')
    if p.exists() and p.stat().st_size>1000:return p
    async with sem:
        for attempt in range(4):
            try:
                await edge_tts.Communicate(text,VOICE,rate='+4%').save(str(p));return p
            except Exception:
                p.unlink(missing_ok=True)
                if attempt==3:raise
                await asyncio.sleep(2+attempt)

async def voices():
    sem=asyncio.Semaphore(2)
    return await asyncio.gather(*(voice_one(s[3],sem) for s in SCENES))

def stamp(t):
    n=round(t*1000);h,n=divmod(n,3600000);m,n=divmod(n,60000);s,n=divmod(n,1000)
    return f'{h:02}:{m:02}:{s:02},{n:03}'

def main():
    audios=asyncio.run(voices())
    elapsed=0;subs=[];clips=[];manifest=[]
    for i,(scene,mp3) in enumerate(zip(SCENES,audios)):
        record,start,end,text,chapter,crop=scene
        pcm=subprocess.run([FF,'-v','error','-i',str(mp3),'-f','s16le','-ar','24000','-ac','1','pipe:1'],capture_output=True,check=True).stdout
        spoken=len(pcm)/48000
        dur=max(spoken+.45, (end-start) if record else 7)
        wav=OUT/f'voice-{i:02}.wav'
        with wave.open(str(wav),'wb') as f:
            f.setnchannels(1);f.setsampwidth(2);f.setframerate(24000)
            f.writeframes(pcm+b'\0\0'*round((dur-spoken)*24000))
        overlay=Image.new('RGBA',(W,H),(0,0,0,0));d=ImageDraw.Draw(overlay)
        d.rectangle((0,0,W,52),fill=(9,12,3,248))
        d.rectangle((0,0,8,52),fill='#ccff00')
        d.text((35,13),chapter,font=font(25,True),fill='#ccff00')
        d.text((1500,16),'TESTNET · TEST ETH',font=font(21),fill='#d4d5ca')
        d.rectangle((0,958,W,H),fill=(9,12,3,252))
        f=font(34,True); lines=wrap(d,text,f,1800)
        assert len(lines)<=2,(i,lines)
        y=982+(2-len(lines))*19
        for line in lines:d.text((60,y),line,font=f,fill='#f4f5ee');y+=42
        overlayPath=OUT/f'overlay-{i:02}.png';overlay.save(overlayPath)
        clip=OUT/f'scene-{i:02}.mp4'
        fingerprint=hashlib.sha256(json.dumps(scene,ensure_ascii=False).encode()).hexdigest()
        cache=OUT/f'scene-{i:02}.sha256'
        if record:
            source=end-start
            args=['-ss',str(start),'-t',str(source),'-i',str(FILES[record-1]),'-loop','1','-i',str(overlayPath),'-i',str(wav)]
            # Crops are visible editorial close-ups of confirmation text; no pixels or transactions are fabricated.
            transform=f'crop={crop[2]}:{crop[3]}:{crop[0]}:{crop[1]},' if crop else ''
            transform+='scale=1920:906:force_original_aspect_ratio=decrease,pad=1920:906:(ow-iw)/2:(oh-ih)/2:color=0x080b03,setsar=1'
            transform+=f',tpad=stop_mode=clone:stop_duration={max(0,dur-source):.3f},pad=1920:1080:0:52:color=0x080b03'
        else:
            card=Image.new('RGB',(W,H),'#080b03');cd=ImageDraw.Draw(card)
            cd.text((135,210),'FlipTheMeme',font=font(104,True),fill='#ccff00')
            cd.text((140,370),'Call the next move.',font=font(62),fill='white')
            cd.text((140,540),'rhc.flipthememe.com/rounds',font=font(64,True),fill='white')
            cd.text((140,675),'Robinhood Chain testnet · Verified contract · Open source',font=font(34),fill='#acaf9f')
            cd.text((140,745),'Simulated demo prices · Founder test activity · Unaudited',font=font(31),fill='#acaf9f')
            cardPath=OUT/'end-card.png';card.save(cardPath)
            args=['-loop','1','-i',str(cardPath),'-loop','1','-i',str(overlayPath),'-i',str(wav)]
            transform='setsar=1'
        filt=f'[0:v]{transform}[base];[base][1:v]overlay=0:0,format=yuv420p[v]'
        if not (clip.exists() and cache.exists() and cache.read_text()==fingerprint):
            run([*args,'-filter_complex',filt,'-map','[v]','-map','2:a','-t',str(dur),'-r','30','-c:v','libx264','-preset','fast','-crf','20','-c:a','aac','-b:a','160k','-movflags','+faststart',str(clip)])
            cache.write_text(fingerprint)
        subs.append(f'{i+1}\n{stamp(elapsed)} --> {stamp(elapsed+spoken)}\n{text}\n')
        manifest.append({'chapter':chapter,'recording':record,'sourceStart':start,'sourceEnd':end,'outputStart':round(elapsed,3),'duration':round(dur,3),'caption':text,'crop':crop})
        clips.append(clip);elapsed+=dur
        print(f'Scene {i+1}/{len(SCENES)} complete ({dur:.1f}s)',flush=True)
    concat=OUT/'scenes.txt';concat.write_text('\n'.join(f"file '{p.as_posix()}'" for p in clips),encoding='utf-8')
    output=OUT/OUTPUT_NAME
    run(['-f','concat','-safe','0','-i',str(concat),'-c','copy','-movflags','+faststart',str(output)])
    (OUT/'captions.srt').write_text('\n'.join(subs),encoding='utf-8')
    (OUT/'transcript.txt').write_text('\n\n'.join(s[3] for s in SCENES)+'\n',encoding='utf-8')
    (OUT/'edit-manifest.json').write_text(json.dumps({'voice':VOICE,'duration':elapsed,'scenes':manifest},indent=2,ensure_ascii=False),encoding='utf-8')
    print(f'FINAL={output}\nDURATION={elapsed:.1f}s\nVOICE={VOICE}',flush=True)

if __name__=='__main__':main()
