"""TTS 文本「演戏」预处理：用标点制造停顿，补语速压不住的疲惫感。

为什么需要它（用户 2026-10-17 的反馈）：
  "语速+8%、音调+2Hz 太像元气小女孩。要平静、微疲、慢、沉。"
  —— edge-tts 只有 `rate`/`pitch` 两个旋钮，**再降就会含糊**；
  剩下的空间只能靠**文本层**：短句拉长（句号→省略号）、长句插逗号（换气停顿）、
  感叹号降级（去元气）。

规则（都是可关的，别一次全开）：
  1. `！` → `。`                    去元气（感叹号会让她"精神起来"）
  2. 短句（≤6 字）的句末 `。` → `……`   把果断的收尾变成拖长的叹气
  3. 长句（≥9 字）在中段插一个 `，`     制造换气点（插在自然词边界前）
  4. 句首语气词（唉/啊/嗯/唔/哦）后面补 `……`（若本来没有）
  5. 连续标点归一（`，，`→`，`、`。。`→`。`），空行/多余空白压掉

⚠️ 别过度：插太多逗号会让 TTS 变成"念单词"，反而假。所以有 `--max-inserts` 上限。

用法：
  <python> tools/tts_polish.py --text "唉……好累。今天外面又下雨了，不想动。"
  <python> tools/tts_polish.py --selftest        # 跑内置用例
"""

from __future__ import annotations

import argparse
import json
import re
import sys

try:
    sys.stdout.reconfigure(errors="replace")  # type: ignore[attr-defined]
except Exception:
    pass

# 句首语气词：后面补一个拖长的省略号，最像"叹气起头"
INTERJECTIONS = ('唉', '啊', '嗯', '唔', '哦', '唉呀', '哎')
# 插逗号时优先放在这些"词边界"之前（前面已经是一个完整的小意群）
SOFT_HEAD = ('在', '就', '都', '又', '陪', '把', '给', '让', '和', '跟', '然后', '可')
# 插逗号时优先放在这些字之后（**只保留多音节词**）
# ⚠️ 别把 `了`/`的` 放进来：会把"想了|很久"切成"想了，很久"，读起来像断气。
#    这是 2026-10-17 实测发现的（"这个问题我想了，很久，还是觉得…"）。
SOFT_TAIL = ('时候', '之后', '以后', '的时候')

SENT_END = '。！？!?…'
CLAUSE_END = '，,、；;：:'


def _normalize(text: str) -> str:
    t = text.replace('\r\n', '\n').replace('\r', '\n')
    t = t.replace('！', '。').replace('!', '。')          # 规则 1
    t = t.replace('，', '，').replace(',', '，')
    t = re.sub(r'[ \t]+', ' ', t)
    t = re.sub(r'，{2,}', '，', t)                        # 规则 5
    t = re.sub(r'。{2,}', '。', t)
    t = re.sub(r'…{3,}', '……', t)
    t = re.sub(r'。…|…。', '……', t)
    t = re.sub(r'\n{3,}', '\n\n', t)
    return t.strip()


def _split_keep(s: str) -> list[str]:
    """按标点切成"段 + 标点"，保留标点本身。"""
    out: list[str] = []
    buf = ''
    for ch in s:
        buf += ch
        if ch in SENT_END or ch in CLAUSE_END:
            out.append(buf)
            buf = ''
    if buf:
        out.append(buf)
    return out


def _short_to_ellipsis(seg: str, max_len: int = 6) -> str:
    """规则 2：短句的句末句号 → 省略号（叹气收尾）。"""
    body = seg.rstrip('。！？!?…')
    tail = seg[len(body):]
    if len(body) <= max_len and tail.endswith('。') and not body.endswith(('，', '、')):
        return body + '……'
    return seg


def _insert_comma(seg: str, min_len: int = 9) -> str:
    """规则 3：长句里插一个逗号，插在自然词边界前（只插一个）。"""
    body = seg.rstrip('。！？!?…，,、；;：:')
    tail = seg[len(body):]
    if '，' in body or len(body) < min_len:
        return seg
    # 已经用逗号收尾的段说明这里本来就是停顿点，别再插（否则会"逗号套逗号"）
    if seg[len(body):].startswith('，'):
        return seg
    mid_start = max(2, int(len(body) * 0.45))
    mid_end = max(mid_start + 1, int(len(body) * 0.8))
    # 优先：在 SOFT_HEAD 之前插
    for i in range(mid_start, min(mid_end, len(body))):
        # 插点两侧都要够长，否则会把词切碎
        if i < 3 or len(body) - i < 3:
            continue
        for h in SOFT_HEAD:
            if body.startswith(h, i):
                return body[:i] + '，' + body[i:] + tail
    # 其次：在 SOFT_TAIL 之后插（只认多音节词）
    for i in range(mid_start, min(mid_end, len(body))):
        if i < 3 or len(body) - i < 3:
            continue
        for w in SOFT_TAIL:
            if body.endswith(w, 0, i + 1):
                return body[: i + 1] + '，' + body[i + 1:] + tail
    return seg


def _interjection_ellipsis(seg: str) -> str:
    """规则 4：句首语气词后面补省略号。"""
    for w in INTERJECTIONS:
        if seg.startswith(w):
            rest = seg[len(w):]
            if rest and not rest.startswith(('…', '，', '。', '、')):
                return w + '……' + rest
            break
    return seg


def polish(text: str, *, rule_short: bool = True, rule_comma: bool = True,
           rule_interjection: bool = True, max_inserts: int = 4) -> str:
    """把一段文本润成"更适合慢速疲惫语气"的样子。"""
    t = _normalize(text)
    segs = _split_keep(t)
    out: list[str] = []
    inserted = 0
    for seg in segs:
        s = seg
        if rule_interjection:
            s = _interjection_ellipsis(s)
        if rule_comma and inserted < max_inserts and s.rstrip('。…').endswith(('。',)) or s.endswith(('。',)):
            pass
        if rule_comma and inserted < max_inserts:
            before = s
            s = _insert_comma(s)
            if s != before:
                inserted += 1
        if rule_short:
            s = _short_to_ellipsis(s)
        out.append(s)
    res = ''.join(out)
    return _normalize(res)


CASES = [
    # (原文, 期望包含)
    ('唉……好累。今天外面又下雨了，不想动，就在屏幕里陪着你吧。',
     ['好累……', '在屏幕里，']),
    ('你好呀，我是小鲸鱼！今天也要一起加油哦！', ['。', '你好呀，']),   # 感叹号降级
    ('嗯。', ['嗯……']),                                                # 极短句
]


def selftest() -> int:
    ok = 0
    bad = 0
    for src, expects in CASES:
        got = polish(src)
        miss = [e for e in expects if e not in got]
        print(json.dumps({'in': src, 'out': got, 'missing': miss}, ensure_ascii=False))
        if miss:
            bad += 1
        else:
            ok += 1
    print(f'--- 通过 {ok}  失败 {bad}')
    return 0 if bad == 0 else 1


def main() -> int:
    ap = argparse.ArgumentParser(description='TTS 文本演戏预处理')
    ap.add_argument('--text', default='')
    ap.add_argument('--selftest', action='store_true')
    ap.add_argument('--max-inserts', type=int, default=4)
    ap.add_argument('--no-short', action='store_true')
    ap.add_argument('--no-comma', action='store_true')
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    if not a.text:
        ap.print_help()
        return 0
    print(polish(a.text, rule_short=not a.no_short, rule_comma=not a.no_comma,
                 max_inserts=a.max_inserts))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
