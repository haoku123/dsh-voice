"""Generate docs/demo.gif: an animated mock of the dsh-voice loop (v0.7).

Simulates the DSH web UI end to end:

1. press-and-hold the composer's send key — its arrow is covered by a mic
   glyph, a waveform overlay opens, and the *live caption* fills in as the
   interim transcripts land (deliberately shown as a rough preview that the
   final pass corrects);
2. release — the waveform freezes and a spinner holds the overlay until the
   authoritative transcript arrives;
3. the transcript is submitted, the reply streams back and is spoken
   sentence-by-sentence (Edge TTS) with live captions;
4. barge-in: the user speaks, playback stops and the running turn is
   cancelled.

Seamless loop: fade in from empty, fade out to empty. Plain Python + Pillow.
"""
import math
import os

from PIL import Image, ImageDraw, ImageFont

W, H = 800, 540
TOTAL = 144
DUR = 50  # ms per frame -> 20 fps, ~7.2s loop

BG = (16, 18, 22)
PANEL = (22, 25, 30)
BUBBLE_USER = (31, 111, 235)
BUBBLE_AI = (33, 38, 45)
CODE_BG = (13, 17, 23)
CARD = (24, 29, 36)
TEXT = (230, 237, 243)
SUB = (139, 148, 158)
GREEN = (63, 185, 80)
RED = (248, 81, 73)
PURPLE = (163, 113, 247)
BLUE = (88, 166, 255)
SEND = (36, 116, 232)
KW = (255, 123, 114)
FN = (210, 168, 255)
WHITE = (255, 255, 255)

SANS = "/System/Library/Fonts/STHeiti Medium.ttc"
MONO = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"

f_title = ImageFont.truetype(SANS, 15)
f_text = ImageFont.truetype(SANS, 16)
f_code = ImageFont.truetype(MONO, 14)
f_cap = ImageFont.truetype(SANS, 12)
f_badge = ImageFont.truetype(SANS, 11)
f_big = ImageFont.truetype(SANS, 44)
f_live = ImageFont.truetype(SANS, 15)

USER_TEXT = "帮我写一个 TypeScript 快速排序"
# The interim transcripts are rough on purpose: they are previews, and the
# final pass is the only authoritative one.
PARTIAL_1 = "帮我写一个"
PARTIAL_2 = "帮我写一个 TS 快排"
SEG1 = "没问题，这是原地快速排序的实现："
CAPTION = "没问题，这是原地快速排序的实现"
CODE = [
    "function quickSort(a, lo, hi) {",
    "  if (lo >= hi) return",
    "  const p = partition(a, lo, hi)",
    "  quickSort(a, lo, p - 1)",
    "  quickSort(a, p + 1, hi)",
    "}",
]

# --- timeline (frames) ---
T_PRESS = 4        # finger lands on the send key
T_OVERLAY = 12     # hold threshold cleared: overlay + mic cover appear
T_P1 = 22          # first interim transcript
T_P2 = 32          # second interim transcript (corrects the first)
T_RELEASE = 42     # released: waveform freezes, spinner spins
T_LAND = 54        # final transcript lands -> submitted
T_REPLY = 56       # assistant bubble starts streaming
T_CAP = 62         # voice capsule starts speaking
T_CODE = 72
CODE_PER = 6
BARGE = 100        # the user's voice interrupts, mid-line
T_BIG = 108

# send key / mic button geometry (siblings in the composer's trailing box)
SEND_BOX = [694, 484, 722, 512]
WAVE_BARS = 28


def lerp(c1, c2, t):
    return tuple(int(a + (b - a) * t) for a, b in zip(c1, c2))


def alpha(c, t):
    return lerp(BG, c, t)


def on(c, bgc, t):
    """Blend `c` over an arbitrary background (for glyphs inside cards)."""
    return lerp(bgc, c, t)


def rrect(d, box, radius, fill=None, outline=None, width=1):
    d.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def draw_chrome(d):
    d.rectangle([0, 0, W, H], fill=BG)
    d.rectangle([0, 0, W, 38], fill=PANEL)
    d.text((18, 10), "dsh", font=f_title, fill=TEXT)
    d.text((58, 11), "session — voice mode", font=f_badge, fill=SUB)
    for i, c in enumerate((RED, (240, 190, 60), GREEN)):
        d.ellipse([W - 62 + i * 18, 14, W - 48 + i * 18, 28], fill=c)


def draw_code(d, x, y, lines_visible):
    for i, item in enumerate(lines_visible):
        if item is None:
            continue
        text, k = item
        s = text[:k]
        yy = y + i * 21
        xpos = x
        j = 0
        while j < len(s):
            matched = False
            for kw in ("function", "return", "if", "const"):
                if s.startswith(kw, j) and (
                    j + len(kw) == len(s) or not s[j + len(kw)].isalnum()
                ):
                    d.text((xpos, yy), kw, font=f_code, fill=KW)
                    xpos += d.textlength(kw, font=f_code)
                    j += len(kw)
                    matched = True
                    break
            if matched:
                continue
            for fn in ("quickSort", "partition"):
                if s.startswith(fn, j):
                    d.text((xpos, yy), fn, font=f_code, fill=FN)
                    xpos += d.textlength(fn, font=f_code)
                    j += len(fn)
                    matched = True
                    break
            if matched:
                continue
            d.text((xpos, yy), s[j], font=f_code, fill=TEXT)
            xpos += d.textlength(s[j], font=f_code)
            j += 1


def eq_bars(d, x, y, w, h, t, color, phase=0.0):
    """Three bouncing bars; the classic 'now speaking' equalizer."""
    for i in range(3):
        k = 0.35 + 0.65 * (0.5 + 0.5 * math.sin(t / 2.2 + i * 1.9 + phase))
        bh = max(2, int(h * k))
        d.rectangle([x + i * (w + 2), y + h - bh, x + i * (w + 2) + w, y + h],
                    fill=color)


def mic_level(t, i):
    """Pseudo-random mic level for waveform bar `i` at frame `t`."""
    return 0.5 + 0.5 * math.sin(t * 0.9 - i * 0.55 + math.sin(i * 1.7) * 1.3)


def draw_wave(d, cx, cy, t, color, bgc, a, frozen=False):
    """The rolling waveform: one bar per audio tick, newest on the right."""
    gap = 6
    total = WAVE_BARS * gap
    x0 = cx - total // 2
    for i in range(WAVE_BARS):
        lv = mic_level(T_RELEASE if frozen else t, i)
        # bars ramp in from the right as the buffer fills
        lv *= 0.25 + 0.75 * min(1.0, max(0.0, (t - T_OVERLAY - i * 0.25) / 6.0))
        bh = max(3, int(3 + lv * 34))
        fade = a * (0.28 if frozen else 0.45 + lv * 0.55)
        x = x0 + i * gap
        rrect(d, [x, cy - bh // 2, x + 3, cy + bh // 2], 2, on(color, bgc, fade))


def draw_mic_glyph(d, cx, cy, s, color):
    """Mic pictogram: capsule head, listening arc, stem and base."""
    rrect(d, [cx - s * 0.17, cy - s * 0.42, cx + s * 0.17, cy + s * 0.06],
          int(s * 0.17), color)
    d.arc([cx - s * 0.33, cy - s * 0.28, cx + s * 0.33, cy + s * 0.3],
          0, 180, fill=color, width=max(1, int(s * 0.08)))
    d.line([cx, cy + s * 0.3, cx, cy + s * 0.44], fill=color,
           width=max(1, int(s * 0.08)))
    d.line([cx - s * 0.17, cy + s * 0.44, cx + s * 0.17, cy + s * 0.44],
           fill=color, width=max(1, int(s * 0.08)))


def draw_spinner(d, cx, cy, r, t, color):
    start = (t * 26) % 360
    d.arc([cx - r, cy - r, cx + r, cy + r], start, start + 260,
          fill=color, width=2)


def draw_press_ring(d, cx, cy, a, arm, t):
    """Hold feedback around the key: a ring that shrinks while the gesture
    arms, then breathes once press-to-talk has engaged.

    Drawn outside the key on purpose — a touch dot on top of it would hide
    the very mic glyph this demo is about.
    """
    if arm < 1.0:
        r = int(25 - 8 * arm)
        color, op = WHITE, 0.4
    else:
        r = 18 + int(1.5 + 1.5 * math.sin(t / 1.6))
        color, op = GREEN, 0.45
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=alpha(color, a * op), width=2)


def frame(t):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    draw_chrome(d)

    # seamless loop: global fade in/out at the edges
    fin = min(1.0, t / 8.0)
    fout = min(1.0, (TOTAL - 1 - t) / 8.0)
    edge = fin * fout
    if edge <= 0:
        return img

    holding = T_OVERLAY <= t < T_RELEASE
    pending = T_RELEASE <= t < T_LAND
    submitted = t >= T_LAND

    # --- user bubble (appears when the transcript lands and is submitted) ---
    ua = min(1.0, (t - T_LAND) / 8.0) * edge if submitted else 0.0
    if ua > 0:
        tw = d.textlength(USER_TEXT, font=f_text)
        rrect(d, [W - 60 - tw - 24, 58, W - 40, 92], 12, alpha(BUBBLE_USER, ua))
        d.text((W - 48 - tw - 12, 66), USER_TEXT, font=f_text, fill=alpha(TEXT, ua))

    # --- streamed assistant reply ---
    seg1_k = max(0, min(len(SEG1), int(t - T_REPLY))) if t >= T_REPLY else 0
    code_lines_vis = []
    for i, line in enumerate(CODE):
        s0 = T_CODE + i * CODE_PER
        if t < s0:
            code_lines_vis.append(None)
        else:
            k = min(len(line), int((t - s0) / CODE_PER * len(line)) + 1)
            code_lines_vis.append((line, k))

    # barge-in: freeze the reply mid-stream
    if t >= BARGE:
        for i in range(len(code_lines_vis)):
            item = code_lines_vis[i]
            if item is None:
                continue
            text, _ = item
            s0 = T_CODE + i * CODE_PER
            if s0 >= BARGE:
                code_lines_vis[i] = None
            else:
                kk = min(len(text), int((BARGE - 1 - s0) / CODE_PER * len(text)) + 1)
                code_lines_vis[i] = (text, kk)

    aia = (1.0 if t >= T_REPLY else 0.0) * edge
    if aia > 0:
        # the bubble grows with the stream instead of reserving the final box
        rows_vis = sum(1 for c in code_lines_vis if c is not None)
        code_bot = 160 + rows_vis * 21 + 6
        rrect(d, [20, 108, 560, (code_bot + 12) if rows_vis else 148], 12,
              alpha(BUBBLE_AI, aia))
        if seg1_k > 0:
            d.text((40, 122), SEG1[:seg1_k], font=f_text, fill=alpha(TEXT, aia))
        if rows_vis:
            rrect(d, [40, 152, 540, code_bot], 8, alpha(CODE_BG, aia))
            draw_code(d, 52, 160, code_lines_vis)

    # --- composer ---
    rrect(d, [60, 480, 740, 518], 18, alpha(PANEL, edge))
    d.text((78, 492), "想问点什么…", font=f_text, fill=alpha(SUB, edge))

    # --- send key: arrow normally, covered by a mic glyph while held ---
    sx = (SEND_BOX[0] + SEND_BOX[2]) / 2
    sy = (SEND_BOX[1] + SEND_BOX[3]) / 2
    if holding or pending:
        # the official arrow icon belongs to the InputBar, so the plugin
        # covers the key with its own circle instead of swapping the glyph
        rrect(d, SEND_BOX, 14, alpha(SEND, edge))
        if pending:
            draw_spinner(d, sx, sy, 7, t, on(WHITE, SEND, edge))
        else:
            draw_mic_glyph(d, sx, sy, 26, on(WHITE, SEND, edge))
    else:
        rrect(d, SEND_BOX, 14, alpha(lerp(PANEL, SEND, 0.55), edge))
        d.line([sx, sy + 6, sx, sy - 6], fill=alpha(WHITE, edge * 0.85), width=2)
        d.line([sx - 5, sy - 1, sx, sy - 6], fill=alpha(WHITE, edge * 0.85), width=2)
        d.line([sx + 5, sy - 1, sx, sy - 6], fill=alpha(WHITE, edge * 0.85), width=2)

    # --- mic button (plugin slot: label + per-state indicator) ---
    rrect(d, [736, 480, 780, 514], 8, alpha(PANEL, edge))
    if t >= BARGE:
        eq_bars(d, 741, 492, 4, 12, t, alpha(GREEN, edge), phase=1.0)
        d.text((757, 493), "说", font=f_badge, fill=alpha(GREEN, edge))
    elif holding:
        d.ellipse([742, 491, 752, 501], fill=alpha(GREEN, edge))
        d.text((756, 491), "松开", font=f_badge, fill=alpha(GREEN, edge))
    elif pending:
        draw_spinner(d, 747, 496, 5, t, alpha(BLUE, edge))
        d.text((756, 491), "识别", font=f_badge, fill=alpha(BLUE, edge))
    else:
        d.ellipse([742, 491, 752, 501], fill=alpha(SUB, edge))
        d.text((756, 491), "mic", font=f_badge, fill=alpha(SUB, edge))

    # --- press-to-talk overlay: waveform + live caption + hint ---
    if holding or pending:
        pop = min(1.0, (t - T_OVERLAY) / 4.0)
        oa = edge * pop
        card = [232, 352, 568, 462]
        rrect(d, card, 18, alpha(CARD, oa),
              outline=alpha(GREEN if holding else BLUE, oa * 0.55), width=1)
        draw_wave(d, 400, 386, t, GREEN, CARD, oa, frozen=pending)

        live = ""
        if t >= T_P2:
            live = PARTIAL_2
        elif t >= T_P1:
            live = PARTIAL_1
        if live:
            lw = d.textlength(live, font=f_live)
            # dimmed once released: the preview is not what will be sent
            col = on(SUB if pending else TEXT, CARD, oa)
            d.text((400 - lw / 2, 408), live, font=f_live, fill=col)
            if holding and t % 12 < 7:
                d.rectangle([400 + lw / 2 + 3, 410, 400 + lw / 2 + 5, 424],
                            fill=on(GREEN, CARD, oa))

        if pending:
            draw_spinner(d, 372, 442, 6, t, on(BLUE, CARD, oa))
            d.text((384, 435), "识别中…", font=f_cap, fill=on(SUB, CARD, oa))
        else:
            hint = "松开发送 · 上滑取消"
            hw = d.textlength(hint, font=f_cap)
            d.text((400 - hw / 2, 435), hint, font=f_cap, fill=on(SUB, CARD, oa))

    # --- keyboard route: the same gesture without leaving the keyboard ---
    if t < T_LAND:
        ka = edge * (1.0 if t >= T_PRESS else 0.0)
        if ka > 0:
            pill = [286, 306, 514, 336]
            rrect(d, pill, 15, alpha(PANEL, ka * 0.9),
                  outline=alpha((70, 76, 86), ka), width=1)
            d.text((302, 313), "或长按", font=f_cap, fill=alpha(SUB, ka))
            rrect(d, [348, 311, 384, 331], 5, alpha((44, 50, 60), ka),
                  outline=alpha((90, 97, 108), ka), width=1)
            d.text((355, 314), "Ctrl", font=f_badge, fill=alpha(TEXT, ka))
            d.text((392, 313), "说话 · Esc 取消", font=f_cap, fill=alpha(SUB, ka))

    # --- touch point on the send key while pressing ---
    if T_PRESS <= t < T_RELEASE:
        draw_press_ring(d, sx, sy, edge,
                        min(1.0, (t - T_PRESS) / (T_OVERLAY - T_PRESS)), t)

    # --- voice capsule: TTS playback with captions, then listening ---
    cap_a = (1.0 if t >= T_CAP else 0.0) * edge
    if cap_a > 0:
        playing = t < BARGE
        cap_box = [560, 434, 780, 466]
        rrect(d, cap_box, 16, alpha((28, 30, 34), cap_a * 0.92))
        rrect(d, cap_box, 16, fill=None, outline=alpha((90, 96, 105), cap_a), width=1)
        if playing:
            eq_bars(d, 574, 444, 4, 14, t, alpha(GREEN, cap_a))
            k = min(max(0, seg1_k), len(CAPTION))
            d.text((598, 441), (CAPTION[:k] or "voice ready")[:30],
                   font=f_cap, fill=alpha(TEXT, cap_a))
        else:
            pulse = int(2.5 + 2.5 * math.sin(t / 1.4))
            d.ellipse([572 - pulse, 443 - pulse, 586 + pulse, 457 + pulse],
                      outline=alpha(RED, cap_a * (0.35 * (1 - pulse / 5.0))), width=1)
            d.ellipse([574, 445, 584, 455], fill=alpha(RED, cap_a))
            d.text((596, 441), "voice: listening…", font=f_cap, fill=alpha(TEXT, cap_a))

    # --- barge-in callout ---
    big_a = (min(1.0, (t - T_BIG) / 8.0) if t >= T_BIG else 0.0) * edge
    if big_a > 0:
        label = "true barge-in"
        tw2 = d.textlength(label, font=f_big)
        d.text(((W - tw2) / 2, 352), label, font=f_big, fill=alpha(PURPLE, big_a * 0.9))
        sub = "你的声音打断正在运行的回答"
        tw3 = d.textlength(sub, font=f_text)
        d.text(((W - tw3) / 2, 408), sub, font=f_text, fill=alpha(SUB, big_a))

    return img


def main():
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
    frames = [frame(t) for t in range(TOTAL)]
    first = frames[0].convert("P", palette=Image.ADAPTIVE, colors=256)
    pf = [f.quantize(palette=first) for f in frames]
    out = os.path.join(out_dir, "docs", "demo.gif")
    pf[0].save(
        out,
        save_all=True,
        append_images=pf[1:],
        duration=DUR,
        loop=0,
        optimize=True,
    )
    size = os.path.getsize(out)
    print(f"demo.gif written: {size // 1024} KB, {len(pf)} frames @ {1000 // DUR} fps")


if __name__ == "__main__":
    main()
