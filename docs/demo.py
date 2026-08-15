"""Generate docs/demo.gif: an animated mock of the dsh-voice loop.

Simulates the DSH web UI: a user prompt, a streamed assistant reply spoken
sentence-by-sentence, then a barge-in (user speaks, the turn stops).
Seamless loop: fade in from empty, fade out to empty.
Runs on plain Python + Pillow, no other deps.
"""
from PIL import Image, ImageDraw, ImageFont

W, H = 800, 540
TOTAL = 88
DUR = 50  # ms per frame -> 20 fps, ~4.4s loop

BG = (16, 18, 22)
PANEL = (22, 25, 30)
BUBBLE_USER = (31, 111, 235)
BUBBLE_AI = (33, 38, 45)
CODE_BG = (13, 17, 23)
TEXT = (230, 237, 243)
SUB = (139, 148, 158)
GREEN = (63, 185, 80)
RED = (248, 81, 73)
PURPLE = (163, 113, 247)
KW = (255, 123, 114)
FN = (210, 168, 255)

SANS = "/usr/share/fonts/dejavu/DejaVuSans.ttf"
MONO = "/usr/share/fonts/dejavu/DejaVuSansMono.ttf"

f_title = ImageFont.truetype(SANS, 15)
f_text = ImageFont.truetype(SANS, 16)
f_code = ImageFont.truetype(MONO, 14)
f_cap = ImageFont.truetype(SANS, 12)
f_badge = ImageFont.truetype(SANS, 11)
f_big = ImageFont.truetype(SANS, 44)
f_mic = ImageFont.truetype(SANS, 10)

USER_TEXT = "Write me a quicksort in TypeScript"
SEG1 = "Here's an in-place quicksort:"
CAPTION = "Here's an in-place quicksort"
CODE = [
    "function quickSort(a, lo, hi) {",
    "  if (lo >= hi) return",
    "  const p = partition(a, lo, hi)",
    "  quickSort(a, lo, p - 1)",
    "  quickSort(a, p + 1, hi)",
    "}",
]
BARGE = 58  # frame where the user's voice interrupts


def lerp(c1, c2, t):
    return tuple(int(a + (b - a) * t) for a, b in zip(c1, c2))


def alpha(c, t):
    return lerp(BG, c, t)


def rrect(d, box, radius, fill):
    d.rounded_rectangle(box, radius=radius, fill=fill)


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

    # --- user bubble (fade in over 12 frames) ---
    ua = min(1.0, t / 12.0) * edge
    if ua > 0:
        tw = d.textlength(USER_TEXT, font=f_text)
        rrect(d, [W - 60 - tw - 24, 58, W - 40, 92], 12, alpha(BUBBLE_USER, ua))
        d.text((W - 48 - tw - 12, 66), USER_TEXT, font=f_text, fill=alpha(TEXT, ua))

    # --- streamed assistant reply ---
    seg1_start, seg1_speed = 12, 1.15
    seg1_k = max(0, min(len(SEG1), int((t - seg1_start) * seg1_speed))) if t >= seg1_start else 0
    code_start, code_per = 38, 6
    code_lines_vis = []
    for i, line in enumerate(CODE):
        s0 = code_start + i * code_per
        if t < s0:
            code_lines_vis.append(None)
        else:
            k = min(len(line), int((t - s0) / code_per * len(line)) + 1)
            code_lines_vis.append((line, k))

    # barge-in: freeze the reply mid-stream
    if t >= BARGE:
        for i in range(len(code_lines_vis)):
            item = code_lines_vis[i]
            if item is None:
                continue
            text, _ = item
            s0 = code_start + i * code_per
            if s0 >= BARGE:
                code_lines_vis[i] = None
            else:
                kk = min(len(text), int((BARGE - 1 - s0) / code_per * len(text)) + 1)
                code_lines_vis[i] = (text, kk)

    aia = (1.0 if t >= 10 else 0.0) * edge
    if aia > 0:
        rrect(d, [20, 108, 490, 330], 12, alpha(BUBBLE_AI, aia))
        if seg1_k > 0:
            d.text((40, 122), SEG1[:seg1_k], font=f_text, fill=alpha(TEXT, aia))
        vis = [c for c in code_lines_vis if c is not None]
        if vis:
            rrect(d, [40, 152, 470, 318], 8, alpha(CODE_BG, aia))
            draw_code(d, 52, 160, code_lines_vis)

    # --- composer ---
    comp_a = edge
    if comp_a > 0:
        rrect(d, [60, 480, 740, 518], 18, alpha(PANEL, comp_a))
        d.text((78, 492), "Ask anything…", font=f_text, fill=alpha(SUB, comp_a))

    # --- mic button ---
    mic_speaking = t >= BARGE
    mic_color = GREEN if mic_speaking else SUB
    if comp_a > 0:
        d.ellipse([748, 486, 770, 508], fill=alpha(PANEL, comp_a))
        d.ellipse([754, 492, 764, 502], fill=alpha(mic_color, comp_a))
        if mic_speaking:
            d.text((744, 462), "speaking…", font=f_mic, fill=alpha(GREEN, comp_a))

    # --- voice capsule ---
    cap_a = (1.0 if t >= 18 else 0.0) * edge
    if cap_a > 0:
        if t >= BARGE:
            cap_text, cap_dot = "voice: listening…", RED
        else:
            k = seg1_k
            cap_text = CAPTION[: min(k, len(CAPTION))] or "voice ready"
            cap_dot = GREEN
        rrect(d, [560, 434, 780, 462], 14, alpha((28, 30, 34), cap_a))
        d.ellipse([572, 441, 584, 453], fill=alpha(cap_dot, cap_a))
        d.text((594, 440), cap_text[:34], font=f_cap, fill=alpha(TEXT, cap_a))

    # --- barge-in callout ---
    big_a = (min(1.0, (t - 62) / 8.0) if t >= 62 else 0.0) * edge
    if big_a > 0:
        label = "true barge-in"
        tw2 = d.textlength(label, font=f_big)
        d.text(((W - tw2) / 2, 360), label, font=f_big, fill=alpha(PURPLE, big_a * 0.9))
        sub = "your voice stops the running turn"
        tw3 = d.textlength(sub, font=f_text)
        d.text(((W - tw3) / 2, 416), sub, font=f_text, fill=alpha(SUB, big_a))

    return img


def main():
    import os
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
    frames = [frame(t) for t in range(TOTAL)]
    first = frames[0].convert("P", palette=Image.ADAPTIVE, colors=256)
    pf = [f.quantize(palette=first) for f in frames]
    pf[0].save(
        os.path.join(out_dir, "docs", "demo.gif"),
        save_all=True,
        append_images=pf[1:],
        duration=DUR,
        loop=0,
        optimize=False,
    )
    size = os.path.getsize(os.path.join(out_dir, "docs", "demo.gif"))
    print(f"demo.gif written: {size // 1024} KB, {len(pf)} frames @ {1000 // DUR} fps")


if __name__ == "__main__":
    main()
