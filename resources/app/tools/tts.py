"""小鲸鱼的 TTS 桥（edge-tts）。

为什么是**长驻子进程 + JSON 行协议**：和 `voice_recorder.py`（STT）同一套架构。
每次说话都重启 Python 要 300~500ms 启动开销，聊天气氛会被这个吞掉；
长驻之后每次说话只有"网络合成"的时间。

两种用法：
  1) **命令行试听/验收**（人耳判断音色）：
       python tools/tts.py --say "你好呀，我是小鲸鱼" --out sample.mp3
  2) **给 Electron 用**（stdin/stdout 各一行 JSON）：
       python tools/tts.py --stdio
       ← {"id":1,"text":"你好呀","voice":"zh-CN-XiaoyiNeural","rate":"+8%","pitch":"+2Hz"}
       → {"id":1,"ok":true,"mp3":"<base64>","ms":1497,"bytes":26640,"cached":false}

设计要点（每条都是实测过的）：
  · **包装在 `.local/pylibs`**（而不是全局 site-packages）：不污染环境，也不会被打进分享包；
    所以启动时把那个目录插进 sys.path。
  · **失败必须返回 JSON 而不是抛栈**：Electron 那边只认 ok=false，不能因为 TTS 崩了就让桌宠没声音又没提示。
  · **不落盘也能用**：音频以 base64 回给 Electron 播放（走渲染层 `<audio>`，
    这样能拿到 `onended` 事件去驱动口型，也不需要装 sounddevice/winsound）。
  · 缓存由调用方（Electron）按哈希管理，这里只做合成。
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import sys
import time

try:
    # ⚠️ Windows 上子进程的 stdin/stdout 默认跟**控制台代码页**（cp936）走，
    #    中文进到 Python 里会变成代理字符（实测报
    #    `'utf-8' codec can't encode character '\udc80'`）。
    #    必须两边都强制 UTF-8：这里 + Electron 端 spawn 时注入 PYTHONIOENCODING。
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")   # type: ignore[attr-defined]
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(HERE)
DEFAULT_LIBS = os.path.join(PROJ, ".local", "pylibs")

DEFAULT_VOICE = "zh-CN-XiaoyiNeural"
DEFAULT_RATE = "+8%"
DEFAULT_PITCH = "+2Hz"


def _load_edge_tts(libs: str):
    if libs and os.path.isdir(libs) and libs not in sys.path:
        sys.path.insert(0, libs)
    import edge_tts  # noqa: WPS433  (延迟导入，才能先把 sys.path 设好)

    return edge_tts


async def synth(edge_tts, text: str, voice: str, rate: str, pitch: str) -> tuple[bytes, float, float]:
    """返回 (mp3 字节, 首音 ms, 总 ms)。"""
    t0 = time.time()
    first_ms: float | None = None
    buf = bytearray()
    comm = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
    async for ch in comm.stream():
        if ch.get("type") != "audio":
            continue
        if first_ms is None:
            first_ms = (time.time() - t0) * 1000
        buf.extend(ch["data"])
    total_ms = (time.time() - t0) * 1000
    return bytes(buf), (first_ms or total_ms), total_ms


def _say_once(edge_tts, text: str, voice: str, rate: str, pitch: str) -> int:
    data, first_ms, total_ms = asyncio.run(synth(edge_tts, text, voice, rate, pitch))
    meta = {
        "ok": bool(data),
        "bytes": len(data),
        "firstAudioMs": round(first_ms),
        "totalMs": round(total_ms),
        "voice": voice,
        "rate": rate,
        "pitch": pitch,
        "chars": len(text),
    }
    print(json.dumps(meta, ensure_ascii=False))
    out = _say_once.out
    if out:
        with open(out, "wb") as f:
            f.write(data)
        print("已写入 " + out, file=sys.stderr)
    return 0 if data else 2


def _serve(edge_tts, voice: str, rate: str, pitch: str, polish_default: bool = False) -> int:
    """stdin/stdout 行协议。一行一个请求，一行一个响应。"""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            print(json.dumps({"ok": False, "error": "bad json"}, ensure_ascii=False), flush=True)
            continue
        rid = req.get("id")
        text = str(req.get("text") or "").strip()
        if not text:
            print(json.dumps({"id": rid, "ok": False, "error": "empty text"}, ensure_ascii=False), flush=True)
            continue
        v = str(req.get("voice") or voice)
        r = str(req.get("rate") or rate)
        p = str(req.get("pitch") or pitch)
        try:
            text = _apply_polish(text, bool(req.get("polish", polish_default)))
            data, first_ms, total_ms = asyncio.run(synth(edge_tts, text, v, r, p))
            print(
                json.dumps(
                    {
                        "id": rid,
                        "ok": bool(data),
                        "mp3": base64.b64encode(data).decode("ascii") if data else "",
                        "bytes": len(data),
                        "firstAudioMs": round(first_ms),
                        "totalMs": round(total_ms),
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        except Exception as e:  # 任何异常都变成 ok:false，别让 Electron 等超时
            print(json.dumps({"id": rid, "ok": False, "error": str(e)[:200]}, ensure_ascii=False), flush=True)
    return 0


def _apply_polish(text: str, enable: bool) -> str:
    """可选：走「演戏」预处理（短句拉长、长句插逗号、感叹号降级）。

    为什么把它放进桥里而不是调用方：**样本和线上必须走同一条路径**，
    否则"试听时好听、上线就变味"——这种 bug 最难查。
    """
    if not enable:
        return text
    try:
        sys.path.insert(0, HERE)
        import tts_polish

        return tts_polish.polish(text)
    except Exception as e:
        print(json.dumps({"polish": False, "error": str(e)[:120]}, ensure_ascii=False), file=sys.stderr)
        return text


def main() -> int:
    ap = argparse.ArgumentParser(description="小鲸鱼 TTS 桥（edge-tts）")
    ap.add_argument("--libs", default=DEFAULT_LIBS, help="edge_tts 所在目录（默认 .local/pylibs）")
    ap.add_argument("--voice", default=DEFAULT_VOICE)
    ap.add_argument("--rate", default=DEFAULT_RATE)
    ap.add_argument("--pitch", default=DEFAULT_PITCH)
    ap.add_argument("--say", default="", help="命令行试听：要念的文本")
    ap.add_argument("--out", default="", help="配合 --say：写到这个 mp3")
    ap.add_argument("--stdio", action="store_true", help="JSON 行服务模式（给 Electron 用）")
    ap.add_argument("--polish", action="store_true", help="先跑 tts_polish（演戏：断句/停顿/去元气）")
    a = ap.parse_args()

    try:
        edge_tts = _load_edge_tts(a.libs)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"edge_tts 加载失败：{e}"}, ensure_ascii=False))
        return 3

    if a.stdio:
        return _serve(edge_tts, a.voice, a.rate, a.pitch, a.polish)
    if a.say:
        _say_once.out = a.out  # type: ignore[attr-defined]
        return _say_once(edge_tts, _apply_polish(a.say, a.polish), a.voice, a.rate, a.pitch)
    ap.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
