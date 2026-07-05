"""Generates 20 placeholder Genesis NFT images (1.png..20.png), 1000x1000.

Placeholder art per docs/nft-artwork-spec.md - one template + minted number,
Base-blue on black. Swap for real designer art before mainnet; this exists so
the IPFS upload / metadata / Deploy.s.sol baseURI wiring can be tested end to
end without waiting on final art.

Usage: python scripts/generate-genesis-nft-art.py
"""
import os
import urllib.request
from PIL import Image, ImageDraw, ImageFont

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(SCRIPT_DIR, "..", "assets", "nft", "genesis")
FONT_CACHE_DIR = os.path.join(SCRIPT_DIR, "..", ".cache")
FONT_PATH = os.path.join(FONT_CACHE_DIR, "JetBrainsMono-Bold.ttf")
FONT_URL = "https://github.com/JetBrains/JetBrainsMono/raw/master/fonts/ttf/JetBrainsMono-Bold.ttf"

BG_COLOR    = "#0a0b0d"
BASE_BLUE   = "#0052FF"
TEXT_WHITE  = "#FFFFFF"
TEXT_GREY   = "#8A919E"


def ensure_font() -> None:
    os.makedirs(FONT_CACHE_DIR, exist_ok=True)
    if not os.path.exists(FONT_PATH):
        print("Downloading JetBrains Mono font...")
        urllib.request.urlretrieve(FONT_URL, FONT_PATH)


def draw_centered_text(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, y: int, color: str) -> None:
    bbox = draw.textbbox((0, 0), text, font=font)
    w = bbox[2] - bbox[0]
    x = (1000 - w) / 2
    draw.text((x, y), text, font=font, fill=color)


def generate() -> None:
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    ensure_font()

    font_title   = ImageFont.truetype(FONT_PATH, 50)
    font_genesis = ImageFont.truetype(FONT_PATH, 130)
    font_number  = ImageFont.truetype(FONT_PATH, 320)
    font_desc    = ImageFont.truetype(FONT_PATH, 45)

    for i in range(1, 21):
        img = Image.new("RGB", (1000, 1000), color=BG_COLOR)
        draw = ImageDraw.Draw(img)

        draw.rectangle([40, 40, 960, 960], outline=BASE_BLUE, width=12)
        draw.rectangle([65, 65, 935, 935], outline=TEXT_GREY, width=2)

        draw_centered_text(draw, "MEMEPRED // ON BASE", font_title, 150, TEXT_GREY)
        draw_centered_text(draw, "GENESIS", font_genesis, 220, BASE_BLUE)
        draw_centered_text(draw, f"#{i}", font_number, 380, TEXT_WHITE)

        draw.line([(350, 750), (650, 750)], fill=BASE_BLUE, width=4)

        draw_centered_text(draw, "STATUS: TRANSFERABLE", font_desc, 790, TEXT_GREY)
        draw_centered_text(draw, "LP FEE BOOST: 1.5x", font_desc, 850, BASE_BLUE)

        img_path = os.path.join(OUTPUT_DIR, f"{i}.png")
        img.save(img_path)
        print(f"Generated: {img_path}")

    print(f"Done - 20 images in {os.path.abspath(OUTPUT_DIR)}")


if __name__ == "__main__":
    generate()
