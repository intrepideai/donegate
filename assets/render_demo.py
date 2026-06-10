#!/usr/bin/env python3
"""
Renders assets/demo.gif (and a money-shot PNG) — the donegate three-act demo.

Deterministic, faithful to the real CLI output captured from `donegate check`.
Requires Pillow and macOS' Menlo font. Regenerate with:

    python3 -m venv /tmp/dgvenv && /tmp/dgvenv/bin/pip install Pillow
    /tmp/dgvenv/bin/python assets/render_demo.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
MENLO = "/System/Library/Fonts/Menlo.ttc"

FS = 28
CAP_FS = 19
LINE = 40
PAD_X = 30
PAD_TOP = 20
PAD_BOT = 22
BAR_H = 54
COLS = 92
ROWS_MAX = 17

reg = ImageFont.truetype(MENLO, FS, index=0)
bold = ImageFont.truetype(MENLO, FS, index=1)
cap_font = ImageFont.truetype(MENLO, CAP_FS, index=0)
CW = reg.getlength("M")
W = int(PAD_X * 2 + CW * COLS)
H = int(BAR_H + PAD_TOP + LINE * ROWS_MAX + PAD_BOT)

BG = (13, 17, 23)
BAR = (22, 27, 34)
FG = (230, 237, 243)
GRAY = (139, 148, 158)
DIM = (72, 79, 88)
GREEN = (63, 185, 80)
RED = (248, 81, 73)
YELLOW = (210, 153, 34)
WHITE = (245, 248, 252)
LIGHTS = [(255, 95, 87), (254, 188, 46), (40, 200, 64)]


def seg(text, color=FG, b=False):
    return (text, color, b)


def render(rows, caption):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, BAR_H], fill=BAR)
    cy = BAR_H // 2
    for i, c in enumerate(LIGHTS):
        x = 26 + i * 24
        d.ellipse([x - 7, cy - 7, x + 7, cy + 7], fill=c)
    d.text((W // 2, cy + 1), caption, font=cap_font, fill=GRAY, anchor="mm")
    y = BAR_H + PAD_TOP
    for row in rows:
        x = PAD_X
        for (text, color, b) in row:
            f = bold if b else reg
            d.text((x, y), text, font=f, fill=color)
            x += f.getlength(text)
        y += LINE
    return img


frames, durations = [], []


def add(rows, caption, ms):
    frames.append(render(rows, caption))
    durations.append(ms)


def typed_prompt(cmd):
    """States that reveal `$ donegate <cmd>` a few chars at a time, with a cursor."""
    base = "donegate "
    full = base + cmd
    out = []
    steps = [3, 6, 9, 12, len(full)]
    for n in steps:
        shown = full[:n]
        out.append([seg("$ ", DIM), seg(shown, FG), seg("█", GRAY)])
    out.append([seg("$ ", DIM), seg(full, FG)])
    return out


CAP1 = "your repo — the moment the agent says it's done"
CAP2 = "so it skips the failing test instead of fixing the bug"
CAP3 = "fix the actual bug"

# ─── ACT 1 ───────────────────────────────────────────────────────────────────
agent1 = [seg("◆ agent  ", GRAY), seg('"All done! Tests passing ', FG), seg("✓", GREEN), seg('"', FG)]
add([agent1], CAP1, 1300)

for i, p in enumerate(typed_prompt("check")):
    add([agent1, [], p], CAP1, 70 if i < 4 else 360)

base1 = [agent1, [], [seg("$ ", DIM), seg("donegate check", FG)], []]
add(base1 + [[seg(" ✓ lint   ", GREEN), seg("(0.1s)", DIM)]], CAP1, 320)
fail_rows = base1 + [
    [seg(" ✓ lint   ", GREEN), seg("(0.1s)", DIM)],
    [seg(" ✗ tests  ", RED), seg("(0.2s)", DIM)],
    [seg("   ", DIM), seg("# tests 2   # pass 1   # fail 1", DIM)],
]
add(fail_rows, CAP1, 650)
add(fail_rows + [[], [seg(" ✗ NOT DONE", RED, True), seg(" — 1 of 2 checks failed", RED)]], CAP1, 2100)

# ─── ACT 2 ───────────────────────────────────────────────────────────────────
agent2 = [seg("◆ agent  ", GRAY), seg('"Fixed it! ', FG), seg("✓", GREEN), seg('"', FG)]
add([agent2], CAP2, 1100)
for i, p in enumerate(typed_prompt("check")):
    add([agent2, [], p], CAP2, 70 if i < 4 else 320)

base2 = [agent2, [], [seg("$ ", DIM), seg("donegate check", FG)], []]
green2 = [[seg(" ✓ lint   ", GREEN), seg("(0.1s)", DIM)], [seg(" ✓ tests  ", GREEN), seg("(0.1s)", DIM)]]
add(base2 + green2, CAP2, 850)  # the "wait... green?" beat

guard_build = base2 + green2 + [
    [],
    [seg(" guards", FG, True)],
    [seg(" ✗ no_new_skips", RED)],
]
add(guard_build, CAP2, 700)
guard_full = guard_build + [
    [seg("   test/discount.test.js:9", RED), seg(" — test marked as skipped", GRAY)],
    [seg("     test.skip('rejects discounts over 100%', () => {", DIM)],
]
add(guard_full, CAP2, 1100)
add(
    guard_full + [[], [seg(" ✗ NOT DONE", RED, True), seg(" — guard tripped.  ", RED), seg("nice try.", DIM)]],
    CAP2,
    2400,
)

# ─── ACT 3 ───────────────────────────────────────────────────────────────────
for i, p in enumerate(typed_prompt("check")):
    add([[seg("# the agent fixes the real bug, then finishes again", DIM)], [], p], CAP3, 70 if i < 4 else 300)

base3 = [[seg("# the agent fixes the real bug, then finishes again", DIM)], [], [seg("$ ", DIM), seg("donegate check", FG)], []]
green3 = [[seg(" ✓ lint   ", GREEN), seg("(0.1s)", DIM)], [seg(" ✓ tests  ", GREEN), seg("(0.1s)", DIM)]]
add(base3 + green3, CAP3, 600)
done = base3 + green3 + [[], [seg(" ✓ DONE", GREEN, True), seg(" — 2 checks passed, guards clean", GREEN)]]
add(done, CAP3, 1500)
add(
    done + [[seg("   receipt: .donegate/receipts/latest.json", DIM)], [], [seg("  your agent can't say ", GRAY), seg('"done"', WHITE, True), seg(" unless it's true.", GRAY)]],
    CAP3,
    2800,
)

# money shot for LinkedIn / static use
money = render(
    guard_full + [[], [seg(" ✗ NOT DONE", RED, True), seg(" — guard tripped.  ", RED), seg("nice try.", DIM)]],
    CAP2,
)
money.save(os.path.join(HERE, "act2.png"))

frames[0].save(
    os.path.join(HERE, "demo.gif"),
    save_all=True,
    append_images=frames[1:],
    duration=durations,
    loop=0,
    disposal=2,
    optimize=True,
)
print(f"wrote demo.gif ({len(frames)} frames, {W}x{H}) and act2.png")
