"""Generates placeholder Farcaster mini-app / OG images referenced by
frontend/public/.well-known/farcaster.json and frontend/index.html.

None of icon.png, icon-512.png, splash.png, og-cover.png, embed.png existed
in frontend/public/ at all -- every image reference in the manifest and the
OG meta tags was a 404. This produces launch-ready placeholders in the
existing Pump.fun-style palette (black bg, JetBrains Mono, green accent)
matching assets/nft/*. Swap for final designer art before mainnet, same as
the badge/genesis NFT art (see docs/nft-artwork-spec.md).

Usage: python scripts/generate-app-images.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(SCRIPT_DIR, "..", "frontend", "public")
FONT_PATH  = os.path.join(SCRIPT_DIR, "..", ".cache", "JetBrainsMono-Bold.ttf")

BG_COLOR     = "#0a0b0d"
GREEN        = "#00ff88"
RED          = "#ff3355"
BASE_BLUE    = "#0052FF"  # official Base brand blue — everything except UP/DOWN uses this

os.makedirs(OUTPUT_DIR, exist_ok=True)


def font(size):
    return ImageFont.truetype(FONT_PATH, size)


def centered_text(draw, cx, y, text, fnt, fill):
    bbox = draw.textbbox((0, 0), text, font=fnt)
    w = bbox[2] - bbox[0]
    draw.text((cx - w / 2, y), text, font=fnt, fill=fill)


def make_icon(size, path):
    """Square app icon: black bg, blue frame/wordmark, green/red side bars
    (the only up/down-coded elements) echoing a candlestick/orderbook motif."""
    img = Image.new("RGB", (size, size), BG_COLOR)
    d = ImageDraw.Draw(img)
    pad = int(size * 0.12)
    bar = max(2, int(size * 0.02))
    d.rectangle([pad, pad, pad + bar * 3, size - pad], fill=GREEN)
    d.rectangle([size - pad - bar * 3, pad, size - pad, size - pad], fill=RED)
    d.rectangle([pad, pad, size - pad, pad + bar], fill=BASE_BLUE)
    d.rectangle([pad, size - pad - bar, size - pad, size - pad], fill=BASE_BLUE)
    mark_font = font(int(size * 0.22))
    centered_text(d, size / 2, size * 0.42, "MP", mark_font, BASE_BLUE)
    img.save(path)


def make_splash(size, path):
    img = Image.new("RGB", (size, size), "#000000")
    d = ImageDraw.Draw(img)
    mark_font = font(int(size * 0.28))
    centered_text(d, size / 2, size * 0.38, "MP", mark_font, BASE_BLUE)
    img.save(path)


def make_wide(w, h, path, title, subtitle):
    """1200x630-class OG/embed image."""
    img = Image.new("RGB", (w, h), BG_COLOR)
    d = ImageDraw.Draw(img)

    # Subtle grid, matching MarketChart.tsx's chart gridlines.
    for i in range(1, 5):
        y = int(h * i / 5)
        d.line([(0, y), (w, y)], fill="#1a1a1a", width=1)

    title_font    = font(int(h * 0.14))
    sub_font      = font(int(h * 0.055))
    up_font       = font(int(h * 0.09))

    centered_text(d, w / 2, h * 0.28, title, title_font, BASE_BLUE)
    centered_text(d, w / 2, h * 0.5, subtitle, sub_font, BASE_BLUE)

    up_text, down_text = "UP", "DOWN"
    gap = int(w * 0.06)
    up_bbox = d.textbbox((0, 0), up_text, font=up_font)
    down_bbox = d.textbbox((0, 0), down_text, font=up_font)
    total_w = (up_bbox[2] - up_bbox[0]) + gap + (down_bbox[2] - down_bbox[0])
    start_x = (w - total_w) / 2
    y = h * 0.68
    d.text((start_x, y), up_text, font=up_font, fill=GREEN)
    d.text((start_x + (up_bbox[2] - up_bbox[0]) + gap, y), down_text, font=up_font, fill=RED)

    img.save(path)


make_icon(1024, os.path.join(OUTPUT_DIR, "icon.png"))
make_icon(512,  os.path.join(OUTPUT_DIR, "icon-512.png"))
make_splash(200, os.path.join(OUTPUT_DIR, "splash.png"))
make_wide(1200, 630, os.path.join(OUTPUT_DIR, "og-cover.png"), "MemePred", "Bet on memes. Win USDC.")
make_wide(1200, 630, os.path.join(OUTPUT_DIR, "embed.png"),    "MemePred", "PvP prediction markets on Base")

print("Generated: icon.png, icon-512.png, splash.png, og-cover.png, embed.png -> frontend/public/")
