"""Render an honest FlipTheMeme HackQuest walkthrough with Ava neural narration."""

from __future__ import annotations

import asyncio
import os
import subprocess
import wave
from dataclasses import dataclass
from pathlib import Path

import aiohttp.connector
import aiohttp.resolver
import edge_tts
import imageio_ffmpeg
from PIL import Image, ImageDraw, ImageFont


# The host's aiodns configuration cannot reach its DNS server. ThreadedResolver
# uses Windows' working system DNS and does not change the neural voice.
aiohttp.connector.DefaultResolver = aiohttp.resolver.ThreadedResolver

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
SHOTS = REPO / "docs" / "rhc" / "measurements" / "rounds-ui"
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
W, H = 1280, 720
BG = (5, 7, 5)
PANEL = (20, 25, 18)
EDGE = (72, 87, 52)
WHITE = (245, 248, 240)
MUTED = (165, 176, 151)
BLUE = (202, 255, 0)
PURPLE = (202, 255, 0)
PINK = (244, 193, 77)
GOLD = (244, 193, 77)
VOICE = "en-US-AvaNeural"


@dataclass(frozen=True)
class Line:
    scene: str
    caption: str


LINES = [
    Line("intro", "There is a meme coin on Robinhood Chain you follow, but no short prediction market for it."),
    Line("intro", "FlipTheMeme gives you an UP or DOWN round on that coin, without buying it."),
    Line("preview", "The current product is a Robinhood Chain testnet prototype. Players stake and collect test ETH."),
    Line("preview", "Its three public demonstration pools have scripted prices. The public preview link is in the description."),
    Line("preview", "The public desktop preview shows three listed pools and a direct ETH betting flow."),
    Line("match", "Each pool shows its depth and the largest matched bank a round can accept."),
    Line("match", "Both sides' totals are visible. Only equal stakes on UP and DOWN actually play."),
    Line("match", "Any excess comes back without a fee. If there is too little opposing stake, everyone gets a full refund."),
    Line("timeline", "A round first takes bets for five minutes, then waits through a five-minute pause."),
    Line("timeline", "The strike is averaged over the next minute. The exit is measured five minutes later."),
    Line("timeline", "Your bet is on the move from that future strike to the exit, not on the price when you click."),
    Line("bet", "For example, a matched stake of 0.01 ETH would collect 0.0196 ETH if it wins."),
    Line("bet", "The contract keeps two percent of the matched bank on a win. A tie or an unpriceable active round returns stakes minus one percent."),
    Line("bet", "The trader confirms the future strike rule and places the bet in one wallet transaction. No swap or token approval."),
    Line("winner", "After settlement, the player's ticket shows the result and a Collect button."),
    Line("winner", "A winning ticket can be collected in ETH. This screen illustrates the result flow."),
    Line("receipts", "A development script completed 40 checks on the current testnet contract with the live keeper."),
    Line("receipts", "An UP stake of 0.005 WETH met an equal DOWN stake. The winner collected 0.0098 WETH."),
    Line("receipts", "The same run checked a tie and a one-sided refund. The script used WETH directly; the public interface uses ETH."),
    Line("fork", "We also tested the round logic against a canonical pool on a local fork of Robinhood Chain mainnet."),
    Line("fork", "The real pool had about 93.5 WETH of depth and enough price history to pass the listing gates."),
    Line("fork", "At an unchanged price, the round tied. Then a simulated swap inside the fork moved the pool's price."),
    Line("fork", "The contract settled UP and paid the winner. That swap was local simulation, not a mainnet trade."),
    Line("end", "Only matched trader stakes fund payouts. Pool depth limits how large a round can be."),
    Line("end", "The direct ETH path passed contract tests. A complete browser-wallet wager is still unrecorded."),
    Line("end", "This is an unaudited testnet prototype. Its development transactions do not prove user demand."),
    Line("end", "Try the public Rounds preview, inspect the verified contract, and reproduce the fork test. The links are below."),
]


def font(size: int, bold: bool = False, mono: bool = False) -> ImageFont.FreeTypeFont:
    name = "consola.ttf" if mono else "arialbd.ttf" if bold else "arial.ttf"
    return ImageFont.truetype(str(Path("C:/Windows/Fonts") / name), size)


def wrap(draw: ImageDraw.ImageDraw, text: str, f: ImageFont.FreeTypeFont, width: int) -> list[str]:
    words = text.split()
    lines: list[str] = []
    cur = ""
    for word in words:
        test = f"{cur} {word}" if cur else word
        if cur and draw.textlength(test, font=f) > width:
            lines.append(cur)
            cur = word
        else:
            cur = test
    if cur:
        lines.append(cur)
    return lines


def text_block(draw: ImageDraw.ImageDraw, xy: tuple[int, int], text: str, size: int, width: int,
               fill=WHITE, bold=False, leading=1.25) -> int:
    f = font(size, bold)
    lines = wrap(draw, text, f, width)
    x, y = xy
    for line in lines:
        draw.text((x, y), line, font=f, fill=fill)
        y += round(size * leading)
    return y


def box(draw: ImageDraw.ImageDraw, xy: tuple[int, int, int, int], fill=PANEL, outline=EDGE, radius=22, width=2):
    draw.rounded_rectangle(xy, radius=radius, fill=fill, outline=outline, width=width)


def cropped_shot(name: str, crop: tuple[int, int, int, int], target: tuple[int, int]) -> Image.Image:
    im = Image.open(SHOTS / name).convert("RGB").crop(crop)
    return im.resize(target, Image.Resampling.LANCZOS)


def screenshot(draw: ImageDraw.ImageDraw, canvas: Image.Image, name: str,
               crop: tuple[int, int, int, int], pos: tuple[int, int], target: tuple[int, int]):
    x, y = pos
    box(draw, (x - 6, y - 6, x + target[0] + 6, y + target[1] + 6), outline=(77, 70, 126), radius=16)
    canvas.paste(cropped_shot(name, crop, target), pos)


def scene_content(canvas: Image.Image, scene: str):
    d = ImageDraw.Draw(canvas)
    if scene == "intro":
        d.text((74, 148), "A SHORT MARKET FOR", font=font(51, True), fill=WHITE)
        d.text((74, 215), "THE MEME COIN YOU FOLLOW", font=font(47, True), fill=WHITE)
        box(d, (76, 322, 548, 440), fill=PANEL, outline=BLUE)
        d.text((108, 350), "UP", font=font(66, True), fill=BLUE)
        box(d, (578, 322, 1050, 440), fill=PANEL, outline=PINK)
        d.text((611, 350), "DOWN", font=font(66, True), fill=PINK)
        d.text((77, 478), "One pool. A published future strike. Matched stakes.", font=font(28), fill=MUTED)
    elif scene == "preview":
        d.text((82, 113), "ROUNDS PREVIEW", font=font(48, True), fill=WHITE)
        for i, token in enumerate(("MOONCAT", "PEPE", "FROGGO")):
            x = 82 + i * 389
            box(d, (x, 218, x + 354, 438), outline=BLUE if i == 0 else EDGE)
            d.text((x + 22, 242), token, font=font(30, True), fill=WHITE)
            d.text((x + 22, 306), "UP  /  DOWN", font=font(26, True), fill=BLUE)
            d.text((x + 22, 369), "TEST ETH", font=font(24), fill=MUTED)
        d.text((84, 513), "rhc.flipthememe.com/rounds", font=font(36, True), fill=BLUE)
    elif scene == "match":
        d.text((82, 124), "EVERYONE SEES THE BANK", font=font(43, True), fill=WHITE)
        box(d, (83, 216, 581, 391), fill=PANEL, outline=BLUE)
        d.text((113, 239), "UP", font=font(33, True), fill=BLUE)
        d.text((113, 289), "0.03 ETH", font=font(53, True), fill=WHITE)
        box(d, (627, 216, 1125, 391), fill=PANEL, outline=PINK)
        d.text((656, 239), "DOWN", font=font(33, True), fill=PINK)
        d.text((656, 289), "0.01 ETH", font=font(53, True), fill=WHITE)
        d.line((321, 425, 884, 425), fill=PURPLE, width=5)
        d.text((340, 443), "0.02 ETH matched bank", font=font(35, True), fill=WHITE)
        d.text((340, 501), "0.02 ETH excess comes back", font=font(28), fill=MUTED)
    elif scene == "timeline":
        d.text((83, 124), "THE FUTURE STRIKE", font=font(49, True), fill=WHITE)
        for i, (label, time) in enumerate((("BET", "5 min"), ("PAUSE", "5 min"), ("STRIKE", "1 min"), ("EXIT", "5 min"))):
            x = 82 + i * 294
            box(d, (x, 239, x + 265, 401), outline=BLUE if i == 2 else EDGE)
            d.text((x + 20, 275), label, font=font(30, True), fill=BLUE if i == 2 else WHITE)
            d.text((x + 20, 337), time, font=font(26), fill=MUTED)
        text_block(d, (84, 475), "Result around 16 minutes after opening. The current price does not count.", 28, 1080, MUTED)
    elif scene == "bet":
        d.text((82, 124), "ONE WALLET CONFIRMATION", font=font(45, True), fill=WHITE)
        box(d, (83, 216, 1192, 450), outline=BLUE)
        d.text((112, 248), "STAKE", font=font(25, True), fill=MUTED)
        d.text((112, 292), "0.01 ETH", font=font(50, True), fill=WHITE)
        d.text((612, 248), "IF YOUR SIDE WINS", font=font(25, True), fill=MUTED)
        d.text((612, 292), "0.0196 ETH", font=font(50, True), fill=BLUE)
        d.text((112, 383), "No swap. No approval. Contract wraps ETH internally.", font=font(25), fill=MUTED)
    elif scene == "winner":
        d.text((82, 111), "RESULT → COLLECT ETH", font=font(49, True), fill=WHITE)
        box(d, (82, 223, 1192, 457), outline=BLUE)
        d.text((114, 257), "WINNING TICKET", font=font(27, True), fill=MUTED)
        d.text((114, 321), "0.0196 ETH", font=font(55, True), fill=WHITE)
        box(d, (789, 303, 1139, 390), fill=BLUE, outline=BLUE)
        d.text((857, 321), "COLLECT", font=font(37, True), fill=BG)
        d.text((88, 520), "Illustration of the result flow; no new live winning ticket claimed.", font=font(23), fill=GOLD)
    elif scene == "receipts":
        d.text((81, 115), "CURRENT TESTNET CONTRACT", font=font(43, True), fill=WHITE)
        for i, (lab, value, color) in enumerate([
            ("UP stake", "0.005 WETH", BLUE),
            ("DOWN stake", "0.005 WETH", PINK),
            ("Winner collected", "0.0098 WETH", PURPLE),
        ]):
            y = 207 + i * 124
            box(d, (81, y, 1190, y + 104), fill=PANEL, outline=color)
            d.text((111, y + 27), lab, font=font(30), fill=MUTED)
            d.text((620, y + 22), value, font=font(40, True), fill=WHITE)
        d.text((90, 593), "Current contract · scripted WETH transactions · live keeper", font=font(22), fill=GOLD)
    elif scene == "fork":
        d.text((78, 115), "REAL POOL. LOCAL FORK.", font=font(45, True), fill=WHITE)
        for i, (lab, value) in enumerate([
            ("Canonical pool", "RMHT / WETH"),
            ("WETH depth", "93.5 WETH"),
            ("Observation history", "1,801 records"),
            ("Local swap result", "UP wins · 0.0196 WETH"),
        ]):
            y = 194 + i * 90
            box(d, (79, y, 1201, y + 75), fill=PANEL, outline=EDGE, radius=14)
            d.text((105, y + 20), lab, font=font(27), fill=MUTED)
            d.text((550, y + 17), value, font=font(32, True), fill=WHITE)
        d.text((91, 590), "Simulated balances, bets, swap, and clock · no mainnet transaction", font=font(22), fill=GOLD)
    elif scene == "end":
        d.text((82, 136), "TRY THE ROUNDS PREVIEW", font=font(47, True), fill=WHITE)
        box(d, (80, 232, 1198, 350), fill=PANEL, outline=BLUE)
        d.text((112, 265), "rhc.flipthememe.com/rounds", font=font(48, True), fill=WHITE)
        text_block(d, (86, 411), "Testnet prototype · Unaudited · Demo prices scripted", 29, 1070, MUTED)
        d.text((87, 510), "Verified contract and reproducible checks in the description", font=font(25), fill=PURPLE)


def render_slide(line: Line, index: int) -> Path:
    canvas = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(canvas)
    d.rectangle((0, 0, W, 7), fill=BLUE)
    d.rounded_rectangle((77, 28, 103, 56), radius=4, fill=BLUE)
    d.line((95, 32, 85, 44, 94, 44, 84, 53), fill=WHITE, width=3)
    d.text((111, 31), "flipthememe", font=font(27, True, True), fill=WHITE)
    d.text((780, 34), "ROBINHOOD CHAIN TESTNET", font=font(18, True), fill=PURPLE)
    scene_content(canvas, line.scene)
    d = ImageDraw.Draw(canvas)
    d.rectangle((0, 617, W, H), fill=(9, 11, 25))
    d.line((74, 615, 1205, 615), fill=(74, 76, 100), width=2)
    caption_font = font(28, True)
    lines = wrap(d, line.caption, caption_font, 1104)
    if len(lines) > 2:
        caption_font = font(25, True)
        lines = wrap(d, line.caption, caption_font, 1104)
    y = 638 + (2 - min(len(lines), 2)) * 15
    for text in lines:
        d.text((80, y), text, font=caption_font, fill=WHITE)
        y += 37
    d.rectangle((0, 713, round(W * (index + 1) / len(LINES)), 720), fill=BLUE)
    path = HERE / "frames" / f"{index:02d}.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(path, optimize=True)
    return path


async def synthesize(index: int, line: Line, sem: asyncio.Semaphore) -> Path:
    path = HERE / "voice-current" / f"{index:02d}.mp3"
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.stat().st_size > 1000:
        return path
    async with sem:
        for attempt in range(4):
            try:
                await edge_tts.Communicate(line.caption, VOICE, rate="+2%").save(str(path))
                if path.stat().st_size <= 1000:
                    raise RuntimeError("empty neural speech")
                return path
            except Exception:
                path.unlink(missing_ok=True)
                if attempt == 3:
                    raise
                await asyncio.sleep(1 + attempt * 2)
    raise RuntimeError("unreachable")


async def synthesize_all() -> list[Path]:
    sem = asyncio.Semaphore(3)
    return await asyncio.gather(*(synthesize(i, line, sem) for i, line in enumerate(LINES)))


def wav_pcm(mp3: Path) -> bytes:
    p = subprocess.run(
        [FFMPEG, "-v", "error", "-i", str(mp3), "-f", "s16le", "-acodec", "pcm_s16le", "-ar", "24000", "-ac", "1", "pipe:1"],
        capture_output=True,
        check=True,
    )
    return p.stdout


def srt_time(seconds: float) -> str:
    ms = round(seconds * 1000)
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"


def main() -> None:
    HERE.mkdir(parents=True, exist_ok=True)
    mp3s = asyncio.run(synthesize_all())
    silence = b"\x00\x00" * int(0.23 * 24000)
    sound: list[bytes] = []
    durations: list[float] = []
    subs: list[str] = []
    elapsed = 0.0
    for i, (line, mp3) in enumerate(zip(LINES, mp3s)):
        pcm = wav_pcm(mp3)
        duration = (len(pcm) + len(silence)) / 2 / 24000
        durations.append(duration)
        sound.extend((pcm, silence))
        subs.append(f"{i + 1}\n{srt_time(elapsed)} --> {srt_time(elapsed + len(pcm) / 2 / 24000)}\n{line.caption}\n")
        elapsed += duration
        render_slide(line, i)
    with wave.open(str(HERE / "ava-voice.wav"), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24000)
        wav.writeframes(b"".join(sound))
    (HERE / "captions.srt").write_text("\n".join(subs), encoding="utf-8")
    (HERE / "transcript.txt").write_text("\n\n".join(line.caption for line in LINES) + "\n", encoding="utf-8")
    (HERE / "description.md").write_text(
        "FlipTheMeme — Robinhood Chain testnet Rounds demo.\n\n"
        "Public demo: https://rhc.flipthememe.com/rounds\n"
        "Current verified contract: https://explorer.testnet.chain.robinhood.com/address/0x1e928adc9de612b08f78824417d4f5ef354c66d7\n"
        "Keeper health: https://api-rhc.flipthememe.com/api/rounds/health\n"
        "Current-contract scripted testnet run: https://github.com/Sofiia7/memepred/blob/claude/charming-mayer-zc0oov/docs/rhc/measurements/rounds/e2e-testnet-60s.log\n"
        "Fork test: https://github.com/Sofiia7/memepred/blob/claude/charming-mayer-zc0oov/docs/rhc/measurements/rounds/mainnet-fork-2026-10-01.md\n"
        "Source repository: https://github.com/Sofiia7/memepred/tree/claude/charming-mayer-zc0oov (public after opening)\n\n"
        "Product-flow screens in this video are illustrations, not recorded browser transactions. "
        "The current-contract testnet transactions were generated by a development script through its WETH entry path. "
        "The direct ETH path passed Foundry tests and the deployed TestWETH passed a deposit/withdraw check; a complete browser-wallet ETH round is not recorded here. "
        "The fork swap was simulated locally. No organic user demand or mainnet betting is claimed.\n",
        encoding="utf-8",
    )
    concat = HERE / "frames.txt"
    entries: list[str] = []
    for i, duration in enumerate(durations):
        path = (HERE / "frames" / f"{i:02d}.png").as_posix()
        entries.append(f"file '{path}'\nduration {duration:.6f}")
    entries.append(f"file '{(HERE / 'frames' / f'{len(LINES) - 1:02d}.png').as_posix()}'")
    concat.write_text("\n".join(entries) + "\n", encoding="utf-8")
    out = HERE / "flipthememe-hackquest-demo.mp4"
    subprocess.run(
        [FFMPEG, "-y", "-v", "warning", "-f", "concat", "-safe", "0", "-i", str(concat),
         "-i", str(HERE / "ava-voice.wav"), "-vf", "fps=24,format=yuv420p", "-c:v", "libx264",
         "-preset", "medium", "-crf", "19", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
         "-shortest", str(out)],
        check=True,
    )
    print(f"VIDEO={out}")
    print(f"DURATION={elapsed:.1f}s")
    print(f"VOICE={VOICE}")


if __name__ == "__main__":
    main()
