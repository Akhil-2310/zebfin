# Generates Zebfin's logo SVGs from pixel grids (same Zeb sprite as the app).
# Usage: python3 web/scripts/make-logo.py web/public/brand  (then copy zebfin-mark.svg to web/src/app/icon.svg)
import sys, os
OUT = sys.argv[1]
INK, ACCENT, CHEEK, BODY, STRIPE, FIN, WHITE = "#3a2c48", "#ff6fa8", "#e2427f", "#fffaf0", "#6b5a7d", "#7fdcbf", "#fdf1e4"
ZEB = [
  "................",
  "......ff........",
  ".....fff........",
  "....kkkkkkkk....",
  "...kwsswwsswwk..",
  "..kwwsswwsswwwk.",
  "..kwwwwwwwwwwwk.",
  ".kwwwwwwwwwwwwwk",
  ".kwwwwwwwwwwwwwk",
  ".kwwwwwwwwwwwwwk",
  ".kwwwwwwwwwwwwwk",
  "..kwwwwwwwwwwwk.",
  "..kwsswwwwsswwk.",
  "...kkwwwwwwwkk..",
  "....kk.kk.kk....",
  "................",
]
FACE = {(7,5):"k",(8,5):"k",(7,10):"k",(8,10):"k",(9,3):"p",(9,12):"p",(10,6):"k",(11,7):"k",(11,8):"k",(10,9):"k"}
# Bold 6x7 pixel letters (2-pixel strokes) to match the badge's weight.
GLYPHS = {
 "Z":["111111","000011","000110","001100","011000","110000","111111"],
 "E":["111111","110000","110000","111110","110000","110000","111111"],
 "B":["111110","110011","110011","111110","110011","110011","111110"],
 "F":["111111","110000","110000","111110","110000","110000","110000"],
 "I":["111111","001100","001100","001100","001100","001100","111111"],
 "N":["110011","111011","111011","110111","110111","110011","110011"],
}
def path(cells, x0=0, y0=0, s=1):
    # One "pixel" = s x s square; merged into a single path per colour.
    return "".join(f"M{x0+c*s:g} {y0+r*s:g}h{s:g}v{s:g}h-{s:g}z" for r, c in cells)
def zeb(x0, y0, s=1):
    by = {}
    for r, row in enumerate(ZEB):
        for c, ch in enumerate(row):
            if ch == ".": continue
            by.setdefault(FACE.get((r, c), ch), []).append((r, c))
    for (r, c), ch in FACE.items():
        if ZEB[r][c] == "w": pass
    col = {"k": INK, "w": BODY, "s": STRIPE, "f": FIN, "p": CHEEK}
    # body first, then face pixels drawn on top
    out = []
    for key in ["w", "s", "f", "k", "p"]:
        cells = [rc for rc in by.get(key, [])]
        if cells: out.append(f'<path fill="{col[key]}" d="{path(cells, x0, y0, s)}"/>')
    return "".join(out)
def mark(x=0, y=0):
    # 24x24: rounded badge with a hard ink outline, Zeb centred inside.
    # Hard ink shadow underneath, like the app's press-down buttons.
    return (f'<rect x="{x+1}" y="{y+2.5}" width="22" height="22" rx="6" fill="{INK}"/>'
            f'<rect x="{x+1}" y="{y+1}" width="22" height="22" rx="6" fill="{ACCENT}" stroke="{INK}" stroke-width="1.5"/>'
            + zeb(x + 4, y + 3.5))
def word(x0, y0, s, fill):
    cells = []
    for i, ch in enumerate("ZEBFIN"):
        for r, row in enumerate(GLYPHS[ch]):
            for c, bit in enumerate(row):
                if bit == "1": cells.append((r, c + i * 7))
    return f'<path fill="{fill}" d="{path(cells, x0, y0, s)}"/>'
def svg(w, h, body, title="Zebfin"):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" shape-rendering="crispEdges" role="img" aria-label="{title}">'
            f'<title>{title}</title>{body}</svg>\n')
files = {
  "zebfin-mark.svg": svg(24, 26, mark()),
  # Horizontal lockup: mark + pixel wordmark (2 units per pixel, 7 rows = 14 tall).
  "zebfin-logo.svg": svg(115, 26, mark() + word(30, 6, 2, INK)),
  "zebfin-logo-dark.svg": svg(115, 26, mark() + word(30, 6, 2, WHITE)),
}
for name, s in files.items():
    open(os.path.join(OUT, name), "w").write(s)
    print(name, len(s), "bytes")
