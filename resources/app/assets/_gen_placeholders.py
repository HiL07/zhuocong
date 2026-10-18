"""
P0 占位角色素材生成器（纯程序化绘制，无任何第三方版权素材）。

产出：
  assets/gif/idle/idle-1..4.png      待机（呼吸 + 眨眼）
  assets/gif/talking/talk-1..3.png   说话（嘴型三档）
  assets/gif/click/click-1..2.png    被点击（压扁 + 睁大眼）
  assets/icon/tray.png               托盘图标

设计要点：
  - 背景全透明（alpha=0），方便自检脚本用 alpha 统计判定透明是否生效
  - 用高饱和青色本体 + 品红描边，在任何桌面壁纸上都容易被人眼定位
运行：
  <python> assets/_gen_placeholders.py
"""

from __future__ import annotations

import math
import os

from PIL import Image, ImageDraw

S = 4  # 超采样倍数（先画大图再缩小，得到抗锯齿边缘）
W = H = 256
CW = CH = W * S

CYAN_TOP = (58, 231, 255, 255)
CYAN_BOT = (26, 122, 214, 255)
MAGENTA = (255, 62, 165, 255)
EYE_WHITE = (255, 255, 255, 255)
PUPIL = (18, 22, 34, 255)
HILITE = (255, 255, 255, 120)

HERE = os.path.dirname(os.path.abspath(__file__))


def lerp(a: tuple[int, int, int, int], b: tuple[int, int, int, int], t: float):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(4))


def body_box(squash: float, lift: float):
    """返回（左, 上, 右, 下）本体矩形，squash 是纵向压扁系数。"""
    bw = CW * 0.62
    bh = CH * 0.56 * squash
    cx = CW / 2
    cy = CH / 2 + CH * 0.04 + lift
    return (cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2)


def draw_frame(squash: float = 1.0, lift: float = 0.0, blink: bool = False,
               mouth: int = 0, wide_eyes: float = 1.0) -> Image.Image:
    img = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
    box = body_box(squash, lift)
    radius = int((box[3] - box[1]) * 0.42)

    # 1) 本体遮罩
    mask = Image.new("L", (CW, CH), 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, radius=radius, fill=255)

    # 2) 垂直渐变填充
    grad = Image.new("RGBA", (CW, CH))
    gd = ImageDraw.Draw(grad)
    y0, y1 = box[1], box[3]
    for y in range(CH):
        t = max(0.0, min(1.0, (y - y0) / max(1.0, y1 - y0)))
        gd.line([(0, y), (CW, y)], fill=lerp(CYAN_TOP, CYAN_BOT, t))
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)

    # 3) 品红描边
    d.rounded_rectangle(box, radius=radius, outline=MAGENTA, width=int(5 * S))

    # 4) 高光
    hl = [box[0] + (box[2] - box[0]) * 0.16, box[1] + (box[3] - box[1]) * 0.12,
          box[0] + (box[2] - box[0]) * 0.46, box[1] + (box[3] - box[1]) * 0.36]
    d.ellipse(hl, fill=HILITE)

    # 5) 眼睛
    bw = box[2] - box[0]
    bh = box[3] - box[1]
    eye_r = bw * 0.105 * wide_eyes
    eye_y = box[1] + bh * 0.40
    for sign in (-1, 1):
        ex = CW / 2 + sign * bw * 0.19
        if blink:
            d.rounded_rectangle(
                [ex - eye_r, eye_y - eye_r * 0.16, ex + eye_r, eye_y + eye_r * 0.16],
                radius=eye_r * 0.16, fill=PUPIL)
        else:
            d.ellipse([ex - eye_r, eye_y - eye_r, ex + eye_r, eye_y + eye_r], fill=EYE_WHITE)
            pr = eye_r * 0.52
            d.ellipse([ex - pr, eye_y - pr * 1.05, ex + pr, eye_y + pr * 0.95], fill=PUPIL)
            sr = pr * 0.36
            d.ellipse([ex - pr * 0.5 - sr, eye_y - pr * 0.75 - sr,
                       ex - pr * 0.5 + sr, eye_y - pr * 0.75 + sr], fill=(255, 255, 255, 230))

    # 6) 嘴
    my = box[1] + bh * 0.70
    if mouth == 0:
        d.arc([CW / 2 - bw * 0.11, my - bh * 0.06, CW / 2 + bw * 0.11, my + bh * 0.09],
              start=15, end=165, fill=PUPIL, width=int(3.2 * S))
    else:
        scale = {1: 0.55, 2: 1.0, 3: 1.45}[mouth]
        mw = bw * 0.10 * (0.7 + 0.5 * scale)
        mh = bh * 0.085 * scale
        d.ellipse([CW / 2 - mw, my - mh * 0.55, CW / 2 + mw, my + mh], fill=PUPIL)

    return img.resize((W, H), Image.LANCZOS)


def save(img: Image.Image, *parts: str) -> None:
    p = os.path.join(HERE, *parts)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    img.save(p)
    print("wrote", os.path.relpath(p, HERE))


def main() -> None:
    # 待机：呼吸 + 第 3 帧眨眼
    save(draw_frame(lift=-3 * S, mouth=0), "gif", "idle", "idle-1.png")
    save(draw_frame(lift=+3 * S, mouth=0), "gif", "idle", "idle-2.png")
    save(draw_frame(lift=+2 * S, mouth=0, blink=True), "gif", "idle", "idle-3.png")
    save(draw_frame(lift=-1 * S, mouth=0), "gif", "idle", "idle-4.png")

    # 说话：三档嘴型
    for i, m in enumerate((1, 2, 3), start=1):
        save(draw_frame(lift=0, mouth=m), "gif", "talking", f"talk-{i}.png")

    # 被点击：压扁 + 睁大眼
    save(draw_frame(squash=0.80, lift=+6 * S, mouth=3, wide_eyes=1.25), "gif", "click", "click-1.png")
    save(draw_frame(squash=0.86, lift=+2 * S, mouth=2, wide_eyes=1.15), "gif", "click", "click-2.png")

    # 托盘图标
    tray = draw_frame(mouth=0).resize((32, 32), Image.LANCZOS)
    save(tray, "icon", "tray.png")

    print("done.")


if __name__ == "__main__":
    main()
