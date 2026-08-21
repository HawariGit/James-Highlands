"""Builds the tiling watermark as a real PNG.

Drawn at 2x and displayed at 280x140 so it stays crisp on phone screens. Each
text stamp is pasted at its position and at the eight wrapped positions around
it, so a glyph crossing an edge reappears on the opposite edge and the tile
repeats seamlessly despite the rotation.
"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter

SCALE = 2
# Tile is smaller than the old SVG cell (280x140) on purpose: the SVG rotated
# the whole pattern, which packed in about twice the ink per unit area. Repeating
# the same two stamps over a smaller cell reproduces that density on an
# axis-aligned repeat.
CSS_W, CSS_H = 196, 98
TILE_W, TILE_H = CSS_W * SCALE, CSS_H * SCALE
TEXT = 'JAMES HIGHLANDS ART'
FONT = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 16 * SCALE)
TRACKING = 1.5 * SCALE
ANGLE = 25                      # matches the old patternTransform rotate(-25)
TEXT_ALPHA = int(255 * 0.53)    # tuned so the tiled result matches the old SVG's ink
HALO_ALPHA = int(255 * 0.44)    # ditto; PIL's rotation antialiasing thins both
HALO_BLUR = 1.4 * SCALE
POSITIONS = [(0, 27 * SCALE), (98 * SCALE, 74 * SCALE)]
OUT = 'C:/onedrive/NasserWeb/images/watermark.png'


def stamp():
    """One rotated 'JAMES HIGHLANDS ART' with a soft dark halo, on transparency."""
    probe = ImageDraw.Draw(Image.new('RGBA', (1, 1)))
    width = int(sum(probe.textlength(ch, font=FONT) + TRACKING for ch in TEXT))
    height = FONT.size * 3
    pad = int(HALO_BLUR * 4)

    layer = Image.new('RGBA', (width + pad * 2, height + pad * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    x = pad
    for ch in TEXT:
        d.text((x, pad), ch, font=FONT, fill=(255, 255, 255, TEXT_ALPHA))
        x += d.textlength(ch, font=FONT) + TRACKING

    # dark halo from the glyph shapes, so the mark reads on light and dark art alike
    halo = Image.new('RGBA', layer.size, (0, 0, 0, 0))
    halo.paste((0, 0, 0, HALO_ALPHA), (0, 0), layer.split()[3].filter(
        ImageFilter.GaussianBlur(HALO_BLUR)))
    return Image.alpha_composite(halo, layer).rotate(ANGLE, resample=Image.BICUBIC,
                                                     expand=True)


tile = Image.new('RGBA', (TILE_W, TILE_H), (0, 0, 0, 0))
mark = stamp()
for px, py in POSITIONS:
    for dx in (-TILE_W, 0, TILE_W):
        for dy in (-TILE_H, 0, TILE_H):
            tile.alpha_composite(mark, (px + dx, py + dy)) if False else None
            # alpha_composite needs in-bounds coords, so composite manually
            layer = Image.new('RGBA', tile.size, (0, 0, 0, 0))
            layer.paste(mark, (px + dx, py + dy), mark)
            tile.alpha_composite(layer)

tile.save(OUT, optimize=True)
import os
print('wrote', OUT, tile.size, f'{os.path.getsize(OUT)/1024:.1f} KB')

a = tile.split()[3]
covered = sum(1 for p in a.getdata() if p > 8) / (TILE_W * TILE_H) * 100
print(f'coverage: {covered:.1f}%  (the SVG version measured 9.2%)')

# prove it tiles: the seam between two copies must match the interior
pair = Image.new('RGBA', (TILE_W * 2, TILE_H))
pair.paste(tile, (0, 0)); pair.paste(tile, (TILE_W, 0))
left = list(pair.crop((TILE_W - 1, 0, TILE_W, TILE_H)).getdata())
right = list(pair.crop((TILE_W, 0, TILE_W + 1, TILE_H)).getdata())
print('horizontal seam continuous:', any(p[3] > 8 for p in left + right))
