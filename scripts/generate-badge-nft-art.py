"""Generates 16 placeholder Badge NFT images (1.png..16.png), 1000x1000.

Placeholder art per docs/nft-artwork-spec.md - one template per rarity tier
(common/rare/epic/legendary) with escalating visual treatment (border
weight, glow, accent color), badge name + rarity + ID. Swap for real
designer art before mainnet; this exists so the IPFS upload / metadata /
BadgeNFT baseURI wiring can be tested end to end without waiting on final art.

Badge list + rarity is pulled 1:1 from contracts/src/BadgeNFT.sol - do not
edit BADGES here without checking the contract stays in sync.

Usage: python scripts/generate-badge-nft-art.py
"""
import os
import urllib.request
from PIL import Image, ImageDraw, ImageFont

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(SCRIPT_DIR, "..", "assets", "nft", "badges")
FONT_CACHE_DIR = os.path.join(SCRIPT_DIR, "..", ".cache")
FONT_PATH = os.path.join(FONT_CACHE_DIR, "JetBrainsMono-Bold.ttf")
FONT_URL = "https://github.com/JetBrains/JetBrainsMono/raw/master/fonts/ttf/JetBrainsMono-Bold.ttf"

BG_COLOR   = "#0a0b0d"
TEXT_WHITE = "#FFFFFF"
TEXT_GREY  = "#8A919E"

# id, name, rarity - from contracts/src/BadgeNFT.sol:38-56
BADGES = [
    (1,  "Beginner",      "common"),
    (2,  "On Fire",       "common"),
    (3,  "Diamond",       "rare"),
    (4,  "Sniper",        "rare"),
    (5,  "Speed",         "common"),
    (6,  "Whale",         "rare"),
    (7,  "To The Moon",   "epic"),
    (8,  "Oracle",        "epic"),
    (9,  "Legend",        "legendary"),
    (10, "Champion",      "legendary"),
    (11, "Pepe Master",   "common"),
    (12, "Brett Fan",     "common"),
    (13, "Pro",           "rare"),
    (14, "Institutional", "epic"),
    (15, "Connector",     "rare"),
    (16, "Network",       "epic"),
]

# Escalating visual treatment by rarity tier: accent color, outer/inner
# border widths, glow intensity (0 = none), corner accent marks.
RARITY_STYLE = {
    "common":    {"accent": "#8A919E", "outer_w": 6,  "inner_w": 0, "glow": 0.0,  "corners": False},
    "rare":      {"accent": "#0052FF", "outer_w": 10, "inner_w": 2, "glow": 0.0,  "corners": False},
    "epic":      {"accent": "#A855F7", "outer_w": 14, "inner_w": 2, "glow": 0.35, "corners": True},
    "legendary": {"accent": "#FFB547", "outer_w": 18, "inner_w": 3, "glow": 0.6,  "corners": True},
}


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


def hex_to_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def add_glow(img: Image.Image, color_hex: str, intensity: float) -> Image.Image:
    """Soft radial glow behind the badge, brightest at center. Drawn as
    concentric circles (widest/most-transparent first) rather than a
    per-pixel gradient - fast enough for 16 images and looks identical."""
    if intensity <= 0:
        return img
    rgb = hex_to_rgb(color_hex)
    glow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(glow)
    cx, cy = img.size[0] // 2, img.size[1] // 2
    max_r, steps = 480, 48
    for i in range(steps, 0, -1):
        r = max_r * i / steps
        alpha = int(90 * intensity * (1 - i / steps))
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=rgb + (alpha,))
    return Image.alpha_composite(img.convert("RGBA"), glow).convert("RGB")


def draw_corner_accents(draw: ImageDraw.ImageDraw, color: str, inset: int = 90, length: int = 40, width: int = 5) -> None:
    """Small diagonal ticks in each corner - reserved for epic/legendary tiers."""
    corners = [(inset, inset, 1), (1000 - inset, inset, -1), (inset, 1000 - inset, 1), (1000 - inset, 1000 - inset, -1)]
    for x, y, sign in corners:
        draw.line([(x, y), (x + length * sign, y)], fill=color, width=width)
        draw.line([(x, y), (x, y + length)], fill=color, width=width)


def generate() -> None:
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    ensure_font()

    font_title  = ImageFont.truetype(FONT_PATH, 42)
    font_rarity = ImageFont.truetype(FONT_PATH, 46)
    font_name   = ImageFont.truetype(FONT_PATH, 74)
    font_id     = ImageFont.truetype(FONT_PATH, 40)

    for badge_id, name, rarity in BADGES:
        style = RARITY_STYLE[rarity]

        img = Image.new("RGB", (1000, 1000), color=BG_COLOR)
        img = add_glow(img, style["accent"], style["glow"])
        draw = ImageDraw.Draw(img)

        # Border(s) - escalates from a single thin line (common) to a
        # thick double border (legendary).
        draw.rectangle([40, 40, 960, 960], outline=style["accent"], width=style["outer_w"])
        if style["inner_w"] > 0:
            draw.rectangle([65, 65, 935, 935], outline=TEXT_GREY, width=style["inner_w"])

        if style["corners"]:
            draw_corner_accents(draw, style["accent"])

        draw_centered_text(draw, "FLIPTHEMEME BADGE", font_title, 130, TEXT_GREY)
        draw_centered_text(draw, rarity.upper(), font_rarity, 210, style["accent"])

        # Badge name wraps to two lines if too wide for the frame.
        name_upper = name.upper()
        bbox = draw.textbbox((0, 0), name_upper, font=font_name)
        if bbox[2] - bbox[0] > 820:
            words = name_upper.split(" ")
            mid = len(words) // 2 or 1
            line1, line2 = " ".join(words[:mid]), " ".join(words[mid:])
            draw_centered_text(draw, line1, font_name, 420, TEXT_WHITE)
            draw_centered_text(draw, line2, font_name, 510, TEXT_WHITE)
        else:
            draw_centered_text(draw, name_upper, font_name, 460, TEXT_WHITE)

        draw.line([(400, 800), (600, 800)], fill=style["accent"], width=4)
        draw_centered_text(draw, f"BADGE #{badge_id:02d}", font_id, 840, TEXT_GREY)

        img_path = os.path.join(OUTPUT_DIR, f"{badge_id}.png")
        img.save(img_path)
        print(f"Generated: {img_path} ({rarity})")

    print(f"Done - {len(BADGES)} images in {os.path.abspath(OUTPUT_DIR)}")


if __name__ == "__main__":
    generate()
