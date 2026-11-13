"""Vygeneruje favicon a ikony aplikace z barev EBC_UI_vibe (src/ebc/ebc-tokens.dark.json).

Motiv: model rozložený po podlažích – izometrický kvádr s nadzvednutou horní deskou v akcentu na tmavé dlaždici
(stejná dlaždice jako ikony BCF Converter a ifc.vr).

Spuštění: python scripts/make-icons.py   (potřebuje Pillow)
Výstup: public/favicon.svg, public/icons/icon-{192,512}.png, icon-maskable-{192,512}.png, apple-touch-icon.png
"""
import json
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
T = json.loads((ROOT / "src" / "ebc" / "ebc-tokens.dark.json").read_text(encoding="utf-8"))
OUT = ROOT / "public" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

BG = T["color.bg.window"]
BORDER = T["color.border.default"]
TOP = T["color.accent.hover"]          # horní plochy (nejsvětlejší)
LEFT = T["color.accent.default"]       # levé stěny
RIGHT = T["color.data.sequential-4"]   # pravé stěny (ve stínu)
SHADE = T["color.data.sequential-1"]   # horní plocha těla pod deskou (stín → deska se čte jako nadzvednutá)

# geometrie v mřížce 64 × 64: půlšířka kvádru, půlvýška kosočtverce, deska (střed y, tloušťka), tělo (střed y, výška)
A, R = 17.0, 9.8
SLAB_Y, SLAB_H = 20.0, 5.0
BODY_Y, BODY_H = 32.0, 11.0
RADIUS = 12.8  # zaoblení dlaždice = 20 % strany


def prism(cy: float, h: float, top: str = TOP):
    """Tři viditelné plochy hranolu: (barva, body)."""
    t, r, b, l = (32, cy - R), (32 + A, cy), (32, cy + R), (32 - A, cy)
    down = lambda p: (p[0], p[1] + h)
    return [(top, [t, r, b, l]), (LEFT, [l, b, down(b), down(l)]), (RIGHT, [b, r, down(r), down(b)])]


FACES = prism(BODY_Y, BODY_H, SHADE) + prism(SLAB_Y, SLAB_H)  # tělo, pak deska nad ním


def svg() -> str:
    polys = "\n".join(
        f'  <path fill="{c}" d="M{" L".join(f"{x:g} {y:g}" for x, y in pts)}Z"/>' for c, pts in FACES)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">\n'
            f'  <title>IFC Viewer</title>\n'
            f'  <rect width="64" height="64" rx="{RADIUS:g}" fill="{BG}"/>\n{polys}\n</svg>\n')


def png(size: int, maskable: bool) -> Image.Image:
    ss = 4  # převzorkování kvůli hladkým hranám
    n = size * ss
    k = n / 64
    img = Image.new("RGBA", (n, n), BG if maskable else (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if not maskable:
        d.rounded_rectangle([0, 0, n - 1, n - 1], RADIUS * k, fill=BG, outline=BORDER, width=max(ss, n // 96))
    s = 0.74 if maskable else 1.0  # maskovatelná ikona: motiv v bezpečné zóně (kruh 80 %)
    for c, pts in FACES:
        d.polygon([((32 + (x - 32) * s) * k, (32 + (y - 32) * s) * k) for x, y in pts], fill=c)
    img = img.resize((size, size), Image.LANCZOS)
    return img.convert("RGB") if maskable else img


(ROOT / "public" / "favicon.svg").write_text(svg(), encoding="utf-8", newline="\n")
for size in (192, 512):
    png(size, False).save(OUT / f"icon-{size}.png")
    png(size, True).save(OUT / f"icon-maskable-{size}.png")
png(180, True).save(OUT / "apple-touch-icon.png")
print("Favicon a ikony uloženy do", ROOT / "public")
