"""
生成桌宠 UI 素材（纯程序化绘制，无第三方版权）。

产出：
  assets/ui/hand.png      拖动时从上方捏住角色的手（蓝白配色，贴合女仆角色的画风）
  assets/ui/shadow.png    角色脚下的椭圆投影

设计要点（第一版被用户否掉：「画风不适配、太大」）：
  - 尺寸收敛到 96x128，实际渲染宽约角色宽度的 22%
  - 描边用柔和的蓝灰 (#7C90B8) 而不是硬黑灰，和 chibi 的软勾线同调
  - 用女仆同款的浅蓝袖口，视觉上属于同一个世界观
  - 捏合手势（拇指+食指），其余手指收回，比「五指张开」更精致
运行：<python> assets/_gen_ui.py
"""

from __future__ import annotations

import os

from PIL import Image, ImageDraw, ImageFilter

S = 6  # 超采样倍数，边缘更细腻
HERE = os.path.dirname(os.path.abspath(__file__))

W, H = 96, 128
CW, CH = W * S, H * S

GLOVE = (253, 254, 255, 255)
GLOVE_SHADE = (222, 231, 245, 255)
CUFF = (198, 216, 243, 255)
CUFF_DEEP = (166, 190, 226, 255)
LINE = (124, 144, 184, 255)
LINE_SOFT = (168, 185, 214, 255)


def rrect(d, box, r, fill=None, outline=None, width=1):
    d.rounded_rectangle(box, radius=int(r), fill=fill, outline=outline, width=int(width))


def make_hand() -> Image.Image:
    img = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    lw = 2.2 * S

    # 袖口（浅蓝，呼应女仆装）
    rrect(d, [CW * 0.30, -CH * 0.02, CW * 0.70, CH * 0.26], CW * 0.11, CUFF, LINE, lw)
    d.line([(CW * 0.30, CH * 0.20), (CW * 0.70, CH * 0.20)], fill=CUFF_DEEP, width=int(1.4 * S))

    # 手掌
    rrect(d, [CW * 0.24, CH * 0.20, CW * 0.78, CH * 0.60], CW * 0.17, GLOVE, LINE, lw)

    # 收起的后三指（画成掌侧的一小块圆弧，暗示指节）
    rrect(d, [CW * 0.52, CH * 0.44, CW * 0.80, CH * 0.64], CW * 0.10, GLOVE_SHADE, LINE_SOFT, lw * 0.7)

    # 食指：从掌下伸出并微微内收，与拇指形成捏合
    rrect(d, [CW * 0.40, CH * 0.46, CW * 0.545, CH * 0.86], CW * 0.072, GLOVE, LINE, lw)

    # 拇指：从左侧伸出，指尖与食指尖相对
    rrect(d, [CW * 0.215, CH * 0.44, CW * 0.36, CH * 0.74], CW * 0.072, GLOVE, LINE, lw)

    # 捏合处的一点点阴影，让「捏住」这件事读得出来
    d.arc([CW * 0.33, CH * 0.60, CW * 0.47, CH * 0.80], start=250, end=110, fill=GLOVE_SHADE, width=int(2.0 * S))

    # 掌背高光
    d.ellipse([CW * 0.32, CH * 0.24, CW * 0.56, CH * 0.40], fill=(255, 255, 255, 150))

    return img.resize((W, H), Image.LANCZOS)


def make_shadow() -> Image.Image:
    img = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse([CW * 0.10, CH * 0.40, CW * 0.90, CH * 0.60], fill=(20, 30, 60, 120))
    img = img.filter(ImageFilter.GaussianBlur(radius=5 * S))
    return img.resize((W, H), Image.LANCZOS)


def main() -> None:
    out = os.path.join(HERE, "ui")
    os.makedirs(out, exist_ok=True)
    for name, im in (("hand.png", make_hand()), ("shadow.png", make_shadow())):
        p = os.path.join(out, name)
        im.save(p)
        print("wrote", os.path.relpath(p, HERE), im.size)


if __name__ == "__main__":
    main()
