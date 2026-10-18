"""
按住说话 → 本地 faster-whisper 识别 → 输出 JSON。

为什么做成**常驻进程 + stdin 控制**：
  「按住说话」需要一个"开始录音 / 停止录音"的信号。每条语音都新起一个进程的话，
  加载模型要 1-3 秒，体验很差。常驻进程只在第一次加载，之后每次识别都是毫秒级。
  主进程用 stdin 发 START / STOP / QUIT 就行，不需要信号、不需要命名管道。

协议（一行一条）：
  stdin   START            开始录音（已在录则忽略）
          STOP             停止录音并识别
          QUIT             退出
  stdout  每行一个 JSON：
          {"kind":"ready"}                    模型已加载，可以 START
          {"kind":"recording"}                开始录音
          {"kind":"result","text":"...","ms":1234,"rms":0.02}
          {"kind":"empty","reason":"too-short"}
          {"kind":"error","message":"..."}

为什么**不做 VAD 切句**：
  按热键的边界就是天然的句子边界（见 docs/research-voice-asr.md §7.1）。

用法：
  python voice_recorder.py --model small --device auto
  python voice_recorder.py --list-devices      列出麦克风
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import sys
import time

# GBK 控制台遇到非 ASCII 会直接把脚本打挂（踩过四次），统一改成 replace
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def emit(**kw) -> None:
    """输出一行 JSON 并立刻 flush —— 主进程要马上读到。"""
    kw["t"] = int(time.time() * 1000)
    sys.stdout.write(json.dumps(kw, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="small", help="tiny/base/small/medium/large-v3")
    ap.add_argument("--device", default="auto", help="auto 或声卡序号")
    ap.add_argument("--lang", default="zh", help="识别语言，zh 或 auto")
    ap.add_argument("--models-dir", default="", help="模型缓存目录（默认放项目里）")
    ap.add_argument("--samplerate", type=int, default=16000)
    ap.add_argument("--min-ms", type=int, default=300, help="短于这个时长就当误触")
    ap.add_argument("--max-ms", type=int, default=15000, help="单次录音上限，到了强制停")
    ap.add_argument("--silence-ms", type=int, default=900,
                    help="说过话之后连续安静这么久就自动停")
    ap.add_argument("--list-devices", action="store_true")
    ap.add_argument("--selftest", type=float, default=0,
                    help="自检：录 N 秒然后识别并退出（不需要 stdin，用于自动化测试）")
    ap.add_argument("--ptt", action="store_true",
                    help="长按模式：本进程自己轮询热键，按下开始、松开结束识别")
    ap.add_argument("--ptt-key", default="0xC0",
                    help="虚拟键码（十六进制）。0xC0 = 波浪键/反引号")
    ap.add_argument("--vad-filter", action="store_true",
                    help="打开 whisper 自带的 Silero VAD。默认关（我们已有自己的静音检测，双开会互相打架）")
    ap.add_argument("--compute-type", default="auto",
                    help="量化精度：auto / int8（快）/ float32（准）/ float16（GPU）")
    args = ap.parse_args()

    # ---------- 依赖路径 ----------
    #
    # ⚠️ 依赖**不在** venv 自己的 site-packages 里，而在 ComfyUI 的 env/deps。
    #    原因：这台机器 pip 会卡死（见 web-research skill），所以走的是
    #    「下载 wheel 手动解压」的路子；而 ComfyUI 的 env/deps 本来就有一套
    #    可用的 numpy/torch/tokenizers，复用它比自己造一套省事得多。
    #
    #    踩过的坑（别重蹈）：
    #      1. sounddevice 必须用 **平台专属 wheel**（py3-none-win_amd64, 986KB），
    #         不是 py3-none-any（32KB，裸壳，没有 PortAudio DLL）
    #      2. ctranslate2 必须用 **cp312 win_amd64** 的 wheel，
    #         拿成 cp310 或 macOS 的会报 "no attribute 'StorageView'"
    here = os.path.dirname(os.path.abspath(__file__))
    # tools -> pet-host -> Projects -> workspace
    ws = os.path.dirname(os.path.dirname(os.path.dirname(here)))

    # ⚠️ 顺序很关键，这里踩过一个坑：
    #    两个目录**不能都 insert(0)** —— 后插的会排到最前面，把先插的盖掉。
    #    .cache/pylibs 里躺着一份 **cp310** 的 ctranslate2（早期误下的），
    #    它一旦排在前面，就会报 "no attribute 'StorageView'"
    #    （Python 3.12 加载不了 cp310 的 _ext.pyd）。
    #    所以：env/deps **插到最前**，pylibs 只作为**兜底追加到最后**。
    deps = os.path.join(ws, "Tools", "ComfyUI", "env", "deps")
    fallback = os.path.join(ws, "Workspace_Config", ".cache", "pylibs")
    if os.path.isdir(deps):
        sys.path.insert(0, deps)
    if os.path.isdir(fallback):
        sys.path.append(fallback)

    # 模型下载走国内镜像（HF 原站被墙）
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    if not args.models_dir:
        # 默认指向已经手动下好的那个本地目录（见 fetch 脚本）。
        # 不用 hf_hub 的缓存机制 —— 它在沙箱里建符号链接会失败。
        local = os.path.join(ws, "Assets", "whisper-models", "faster-whisper-%s" % args.model)
        args.models_dir = local if os.path.isdir(local) else os.path.join(ws, "Assets", "whisper-models")

    try:
        import numpy as np
        import sounddevice as sd
    except Exception as e:
        emit(kind="error", message="音频依赖缺失: %s（先跑 tools/fetch_pylibs.py）" % e)
        return 2

    if args.list_devices:
        try:
            for i, d in enumerate(sd.query_devices()):
                if d.get("max_input_channels", 0) > 0:
                    print("  [%d] %s  (%d ch)" % (i, d["name"], d["max_input_channels"]))
        except Exception as e:
            print("  枚举失败:", e)
        return 0

    # ---------- 加载模型（只做一次）----------
    #
    # ⚠️ 这里有个关键区别：`WhisperModel` 的第一个参数既可以是 **repo 名**（"small"），
    #    也可以是 **本地目录路径**。传 repo 名它会走 huggingface_hub 去下载，
    #    而在沙箱里 hf_hub 建符号链接会失败（Permission denied: dummy_file_src）。
    #    所以：**本地目录存在就优先用本地目录**，彻底不碰网络。
    local_model = os.path.join(ws, "Assets", "whisper-models", "faster-whisper-%s" % args.model)
    use_local = os.path.isfile(os.path.join(local_model, "model.bin"))
    model_ref = local_model if use_local else args.model

    emit(kind="loading", model=args.model, source="local" if use_local else "download",
         path=model_ref)
    t0 = time.time()
    try:
        from faster_whisper import WhisperModel
        os.makedirs(args.models_dir, exist_ok=True)
        # ⚠️ 关于 device，实测过一个坑：
        #    用 cuda 能**加载**模型（get_cuda_device_count() > 0），
        #    但**推理**时会报 `Library cublas64_12.dll is not found or cannot be loaded`——
        #    因为 cuBLAS 在 torch 的目录里，而 Windows 的 DLL 搜索路径不认 sys.path。
        #    所以默认走 **CPU**：实测 int8 是 **14.3 倍实时率**（20 秒音频 1.4 秒），
        #    5 秒的一句话只要 0.35 秒，完全够用，不值得为 GPU 去改 PATH。
        #    真想用 GPU 就把 --device cuda 显式传进来（需要先把 CUDA 的 bin 加进 PATH）。
        if args.device == "cuda":
            dev = "cuda"
        elif args.device == "cpu":
            dev = "cpu"
        else:
            dev = "cpu"  # auto → 保守选 CPU，理由见上
        # 量化精度：直接决定准确率。
        #   int8      = 最快，但量化损失明显（实测会把"要趁着"听成"要趁到"）
        #   float32   = 最准，CPU 上约慢 2 倍（实测 7.7 秒音频 1.9s → 3.9s）
        #   float16   = GPU 用；CPU 上 float16 反而很慢，别选
        #   auto      = GPU→float16，CPU→int8
        ct = (args.compute_type or "auto").lower()
        if ct == "auto":
            ctype = "float16" if dev == "cuda" else "int8"
        elif ct in ("int8", "float32", "float16", "int8_float32", "bfloat16"):
            ctype = ct
        else:
            emit(kind="error", message="未知的 computeType: %s" % ct)
            return 6
        emit(kind="precision", device=dev, computeType=ctype)
        model = WhisperModel(
            model_ref,
            device=dev,
            compute_type=ctype,
            download_root=args.models_dir,
        )
    except Exception as e:
        emit(kind="error", message="模型加载失败: %s" % e)
        return 3

    emit(kind="ready", model=args.model, device=dev, computeType=ctype,
         loadMs=int((time.time() - t0) * 1000))

    # ---------- 录音状态 ----------
    sr = args.samplerate
    q: "queue.Queue" = queue.Queue()
    chunks: list = []
    recording = False
    started_at = 0.0

    def callback(indata, frames, tinfo, status):  # noqa: ANN001
        if status:
            # 溢出之类的状态不致命，记一下就好，别打断录音
            pass
        if recording:
            q.put(indata.copy())

    # ---------- 打开麦克风 ----------
    #
    # ⚠️ PortAudio 会按顺序试各种「宿主接口」(host API)，默认常常落到最老的 **MME**，
    #    而 MME 在现代 Windows 上经常直接失败：
    #        Unanticipated host error [PaErrorCode -9999] ... [MME error 1]
    #    所以要**主动**优先用 WASAPI（最现代、延迟最低），其次 DirectSound，最后才 MME。
    #    做法：逐个宿主接口试着开流，第一个成功的就用它。
    # 麦克风选择的缓存文件。
    # ⚠️ 必须定义在 open_stream **外面** —— 打不开时的错误处理里要删掉它
    #    （缓存了一个"现在不存在"的设备是最常见的失败原因，比如蓝牙耳机没开）。
    cache_path = os.path.abspath(os.path.join(here, "..", ".local", "mic.json"))

    def open_stream():
        if args.device != "auto":
            # 用户显式指定了设备号，直接用
            return sd.InputStream(samplerate=sr, channels=1, dtype="float32",
                                  device=int(args.device), callback=callback), "device=%s" % args.device

        # ⚠️ 先试**上次成功的组合**并缓存。
        #    为什么需要：按顺序试宿主接口时，失败的几个各自要等超时，
        #    实测首次打开麦克风要 **30 秒**（WASAPI/DirectSound/MME 全失败后才轮到 WDM-KS）。
        #    缓存之后每次都是秒开。
        cache = cache_path
        try:
            with open(cache, "r", encoding="utf-8") as f:
                c = json.load(f)
            dev_i = int(c["device"])
            # ⚠️ 先**校验这个设备现在还在不在**，再打开。
            #    为什么要这一步：蓝牙设备忽隐忽现，缓存里记的序号可能已经失效。
            #    不校验的话 PortAudio 会去打开一个不存在的设备并**卡到超时**，
            #    用户看到的是"要等半分钟才报错"。
            #    校验通过才试打开，失败立刻往下走去探测。
            ok_dev = False
            try:
                dinfo = sd.query_devices(dev_i)
                ok_dev = dinfo is not None and dinfo.get("max_input_channels", 0) > 0
            except Exception:
                ok_dev = False
            if not ok_dev:
                emit(kind="cacheInvalid", device=dev_i,
                     note="缓存里的设备已不存在，重新探测")
                raise RuntimeError("cached device gone")
            st = sd.InputStream(samplerate=int(c.get("samplerate", sr)), channels=1,
                                dtype="float32", device=dev_i, callback=callback)
            return st, "cached dev %s (%s)" % (dev_i, c.get("hostapi", "?"))
        except Exception:
            pass

        # ⚠️ 只试 **Windows 默认输入设备** 和 **WASAPI 的默认输入** 两个。
        #
        #    原来是把所有宿主接口 × 所有采样率都试一遍，失败的每一个都要等
        #    PortAudio 超时 —— 实测首次打开要 **30 秒**，而且全失败时用户只能干等。
        #    MME/WDM-KS 在现代 Windows 上基本没用（MME error 1 / Invalid device），
        #    试它们纯属浪费时间。
        last = None
        cands = []
        try:
            din = sd.default.device[0]
            if din is not None and din >= 0:
                cands.append((din, "system-default"))
        except Exception:
            pass
        try:
            for i, a in enumerate(sd.query_hostapis()):
                if a["name"] == "Windows WASAPI":
                    d2 = a.get("default_input_device", -1)
                    if d2 is not None and d2 >= 0 and all(c[0] != d2 for c in cands):
                        cands.append((d2, "WASAPI-default"))
                    break
        except Exception:
            pass

        for dev_i, label in cands:
            for rate in (sr, 48000, 44100):
                try:
                    st = sd.InputStream(samplerate=rate, channels=1, dtype="float32",
                                        device=dev_i, callback=callback)
                    try:
                        os.makedirs(os.path.dirname(cache), exist_ok=True)
                        with open(cache, "w", encoding="utf-8") as f:
                            json.dump({"device": dev_i, "hostapi": label, "samplerate": rate}, f)
                    except Exception:
                        pass
                    return st, "%s (dev %d, %d Hz)" % (label, dev_i, rate)
                except Exception as e:  # noqa: BLE001
                    last = "%s@%d: %s" % (label, rate, e)
        raise RuntimeError("打不开默认输入设备。最后一次: %s" % last)

    try:
        stream, how = open_stream()
        emit(kind="mic", hostapi=how, samplerate=sr)
    except Exception as e:
        # 打不开时把**当前能用的输入设备**列出来。
        # 为什么：最常见的原因就是"上次记下的那个设备现在不在了"
        # （比如蓝牙耳机没开机），只报一句错误没法定位。
        avail = []
        try:
            for i, d in enumerate(sd.query_devices()):
                if d.get("max_input_channels", 0) > 0:
                    avail.append("%d:%s" % (i, d["name"][:26].replace("\n", " ")))
        except Exception:
            pass
        emit(kind="error",
             message="打不开麦克风: %s" % e,
             availableInputs=avail[:10],
             count=len(avail),
             hint=("一个输入设备都没有 —— 检查耳机是否插好/开机，"
                   "或 Windows 声音设置里麦克风是否被禁用"
                   if not avail else "上面这些是当前枚举到的输入设备"))
        # 清掉可能失效的缓存，下次重新探测
        try:
            if os.path.exists(cache_path):
                os.remove(cache_path)
        except Exception:
            pass
        return 4

    stream.start()

    # ---------- 自动停止（看门狗）----------
    #
    # 录到「说过话之后又安静了」就自动停，或者到达 maxMs 强制停。
    # 这样上层只需要发一次 START，不必再发 STOP。
    import threading

    _lock = threading.Lock()

    def _transcribe(audio, why: str, dur_ms: int) -> None:
        """归一化 → 识别 → 输出。所有路径共用，避免两处走样。"""
        import numpy as _np

        # ⚠️ 每次都把**原始录音**存一份，方便事后亲耳听。
        #    为什么必须留这个：识别不对时，光看 rms 数字判断不了
        #    "到底是没录到声音，还是录到了但模型听不出来"。
        #
        #    ⚠️⚠️ **不覆盖**！按时间戳命名。
        #    踩过的坑：原来固定写 last-voice.wav，结果最有价值的那份
        #    "清晰语音"样本被后续的参数测试冲掉了，只能重录。
        #    调试样本必须留档，否则等于没有。
        try:
            import wave as _wave
            dbg_dir = os.path.abspath(os.path.join(here, "..", ".local", "voice-debug"))
            os.makedirs(dbg_dir, exist_ok=True)
            dbg = os.path.join(dbg_dir, "voice-%d.wav" % int(time.time() * 1000))
            # last-voice.wav 仍然更新，方便"听最近那次"
            latest = os.path.abspath(os.path.join(here, "..", ".local", "last-voice.wav"))
            pcm = _np.clip(audio, -1.0, 1.0)
            data = (pcm * 32767).astype("<i2").tobytes()
            for path in (dbg, latest):
                with _wave.open(path, "wb") as w:
                    w.setnchannels(1)
                    w.setsampwidth(2)
                    w.setframerate(sr)
                    w.writeframes(data)
        except Exception:
            dbg = None

        rms = float(_np.sqrt(_np.mean(audio ** 2))) if audio.size else 0.0

        # ⚠️ 归一化：实测录进来的 rms 只有 0.0008 左右（约 -61 dBFS），
        #    而正常说话应该是 -20~-30 dBFS。信号弱 30 多倍时，
        #    whisper 会把底噪"听成"随机汉字（实测出现过
        #    "八百飙冰笨北坡炮冰病排北边炮" 这种 16 个音节的垃圾）。
        #    这里把峰值拉到 -3 dBFS，让模型拿到正常电平。
        peak = float(_np.max(_np.abs(audio))) if audio.size else 0.0
        gain = 0.0
        if peak > 1e-6:
            # 上限 300 倍：实测弱麦（Windows 电平条只有 10%）需要 ~54 倍，
            # 留够余量；再高就说明根本没信号，放大只会得到噪声。
            gain = min(0.707 / peak, 300.0)
            audio = audio * gain

        t1 = time.time()
        try:
            segs, info = model.transcribe(
                audio,
                language=None if args.lang == "auto" else args.lang,
                beam_size=5,
                # ⚠️ vad_filter 默认**关掉**。
                #    原因：我们自己已经有静音检测（看门狗 + 自适应阈值），
                #    再叠一层 Silero VAD 就是**双重判定** —— 两套标准不一致时，
                #    整段音频可能被 Silero 滤光，whisper 拿到空音频就**复读
                #    initial_prompt**（实测出现过，rms 0.045 明明有声音却输出
                #    "请用简体中文输出。"）。要用就显式 --vad-filter 打开。
                vad_filter=bool(args.vad_filter),
                # whisper 经常会输出**繁体**。initial_prompt 用简体中文能把
                # 输出偏到简体（社区通用做法，比事后转换可靠）。
                initial_prompt=("以下是普通话的句子，请用简体中文输出。"
                                if args.lang != "auto" else None),
            )
            text = "".join(s.text for s in segs).strip()
        except Exception as e:
            emit(kind="error", message="识别失败: %s" % e)
            return

        # ⚠️ whisper 在**音频听不清**时会**复读 initial_prompt**。
        #    实测用户遇到过输出「请输入简体中文」—— 注意提示词里是「请用简体中文**输出**」，
        #    词序和用词都被改写了。所以**子串匹配靠不住**，必须用关键词判定。
        #    下面这些词不可能出现在你和桌宠的日常对话里，命中即判为复读。
        _ECHO_KEYS = ("简体中文", "繁体中文", "普通话", "以下是")
        if text and any(k in text for k in _ECHO_KEYS) and len(text) <= 24:
            emit(kind="empty", reason="prompt-echo", rms=round(rms, 5),
                 echo=text, why=why, debugWav=dbg,
                 note="识别结果像提示词复读（命中关键词且很短）—— 这段音频里没有可辨认的语音")
            return

        emit(kind="result", text=text, ms=int((time.time() - t1) * 1000),
             audioMs=dur_ms, rms=round(rms, 5), gain=round(gain, 1),
             lang=getattr(info, "language", None), why=why, debugWav=dbg)

    def _finish(reason: str) -> None:
        """停止录音并识别，结果通过 stdout 发出去。只在看门狗线程里跑。"""
        nonlocal recording
        with _lock:
            if not recording:
                return
            recording = False
            dur_ms = int((time.time() - started_at) * 1000)
            buf = []
            while not q.empty():
                try:
                    buf.append(q.get_nowait())
                except Exception:
                    break
        # ⚠️ 立刻释放麦克风（在识别之前）。
        #    识别要好几秒，这段时间没必要占着设备 ——
        #    用户能看到 Windows 的"麦克风正在使用"提示，会以为程序没停。
        try:
            if stream.active:
                stream.stop()
            # 直接上报"流是否还开着" —— 这是"麦克风有没有被释放"的**直接证据**，
            # 比从另一个进程去试打开可靠得多。
            emit(kind="micReleased", active=bool(stream.active), why=reason)
        except Exception:
            pass
        if dur_ms < args.min_ms or not buf:
            emit(kind="empty", reason="too-short", ms=dur_ms, why=reason)
            return
        audio = np.concatenate(buf, axis=0).flatten()
        rms0 = float(np.sqrt(np.mean(audio ** 2))) if audio.size else 0.0
        if rms0 < 1e-5:
            emit(kind="empty", reason="silent", rms=round(rms0, 6), why=reason)
            return
        _transcribe(audio, reason, dur_ms)

    def _begin(why: str) -> None:
        """开始录音。所有入口（stdin START / 长按热键）共用。"""
        nonlocal recording, started_at
        if recording:
            return
        with _lock:
            while not q.empty():
                try:
                    q.get_nowait()
                except Exception:
                    break
            # ⚠️ 每次开始录音才打开麦克风（配合 _finish 里的 stop）。
            #    原来流是常开的，用户反馈"录音停了但麦克风还在被占用"—— 就是这里。
            try:
                if not stream.active:
                    stream.start()
            except Exception as e:  # noqa: BLE001
                emit(kind="error", message="打不开录音流: %s" % e)
                return
            recording = True
            started_at = time.time()
        emit(kind="recording", why=why)
        _start_watchdog()

    def _start_ptt(vk: int) -> None:
        """
        真正的「长按说话」：轮询 Windows 的按键状态。

        为什么需要：Electron 的 globalShortcut **只有按下事件，没有松开**，
        所以没法做长按。而 GetAsyncKeyState 能读到"这个键此刻是否按着" ——
        Ctrl/Alt 之外它也不需要焦点，是全局的。

        为什么放在 Python 里：ctypes 直接调 user32，**不用加任何依赖**，
        也不用装原生 Node 模块。录音器本来就是常驻进程，顺手轮询最省事。
        """
        try:
            import ctypes
            user32 = ctypes.windll.user32
        except Exception as e:  # noqa: BLE001
            emit(kind="error", message="长按模式不可用（ctypes 失败）: %s" % e)
            return

        def run() -> None:
            prev = False
            while True:
                time.sleep(0.03)  # 30ms 轮询，足够跟上人的手速
                try:
                    down = bool(user32.GetAsyncKeyState(vk) & 0x8000)
                except Exception:
                    return
                if down and not prev:
                    # 打日志：这是定位"松手不停止"的关键数据。
                    # 如果按下去有 ptt-key down、松开**没有** up，说明
                    # GetAsyncKeyState 看不到松开（很可能是 Electron 的
                    # globalShortcut 把键吞了）；两者都有说明是 _finish 的问题。
                    emit(kind="ptt-key", down=True)
                    _begin("ptt-down")
                elif not down and prev:
                    emit(kind="ptt-key", down=False)
                    # 松开 → 停止并识别。这就是长按模式的关键一步。
                    _finish("ptt-up")
                prev = down

        threading.Thread(target=run, daemon=True).start()
        emit(kind="ptt", vk=hex(vk), pollMs=30)

    def _start_watchdog() -> None:
        """自动收尾看门狗：说完了安静下来就停，或到上限强制停。"""
        def run() -> None:
            # ⚠️ 阈值必须**自适应**，不能用固定的 0.01。
            #    实测用户的麦克风说话时 rms 只有 0.0002 左右，
            #    固定阈值下永远判不出"在说话"，静音停止就永远不会触发。
            #    做法：先量 400ms 底噪，之后动态跟踪峰值，
            #    阈值取「底噪 × 4」和「近期峰值 × 0.25」里较大的一个，并设下限。
            noise_floor = None
            peak_recent = 0.0
            speech_seen = False
            quiet_run = 0.0
            t0 = time.time()
            while True:
                time.sleep(0.1)
                if not recording:
                    return
                elapsed_ms = (time.time() - t0) * 1000
                if elapsed_ms >= args.max_ms:
                    _finish("max-ms")
                    return
                # 从队列里偷看当前能量（不消费，避免和 _finish 抢）
                try:
                    chunk = q.queue[-1]
                    level = float(np.sqrt(np.mean(chunk ** 2)))
                except Exception:
                    level = 0.0

                if noise_floor is None:
                    if elapsed_ms < 400:
                        continue
                    noise_floor = max(level, 1e-6)
                    continue

                # 阈值：底噪的 4 倍起，随近期峰值自适应，再兜一个绝对值下限
                thr = max(noise_floor * 4.0, peak_recent * 0.25, 3e-5)
                if level > thr:
                    speech_seen = True
                    quiet_run = 0.0
                    peak_recent = max(peak_recent, level)
                elif speech_seen:
                    quiet_run += 100
                    # ⚠️ 长按模式下静音停止只当**兜底**，阈值放宽到 2.5 秒。
                    #    正常情况松手就该停（由按键轮询负责）；万一按键检测失灵，
                    #    也不至于一直录到 max-ms。
                    #    但阈值不能小 —— 用户实测反馈"一不说话就被切断"，
                    #    就是原来 900ms 太激进。
                    _sil = max(args.silence_ms, 2500) if args.ptt else args.silence_ms
                    if quiet_run >= _sil:
                        _finish("silence-fallback" if args.ptt else "silence")
                        return
        threading.Thread(target=run, daemon=True).start()

    # ---------- 长按模式 ----------
    #
    # 开了 --ptt 就自己轮询热键，**不需要上层发 START/STOP**。
    # 这是唯一能做到真正「按住说话」的办法：Electron 的 globalShortcut
    # 拿不到按键松开事件，而 GetAsyncKeyState 能。
    if args.ptt:
        try:
            _vk = int(args.ptt_key, 16) if isinstance(args.ptt_key, str) else int(args.ptt_key)
        except Exception:
            _vk = 0xC0
        _start_ptt(_vk)

    # ---------- 自检模式 ----------
    #
    # 录固定秒数然后识别，不需要 stdin 驱动。
    # 为什么需要这个：DSH 沙箱里没法用管道给子进程喂 stdin
    # （命名管道被拦，会 EPERM），所以自动化测试只能用这个模式。
    # 它走的是**和正常流程完全一样**的代码路径（同一个 stream、同一份 model）。
    if args.selftest > 0:
        # 自检**走看门狗本身**，而不是另写一段定长录音 ——
        # 只有这样才能验证"自动停止"这条真实代码路径
        # （沙箱里 spawn+管道会 EPERM，没法从外面喂 START）。
        global_started = time.time()
        args.max_ms = int(args.selftest * 1000)
        recording = True
        started_at = global_started
        emit(kind="recording", selftest=True, maxMs=args.max_ms, silenceMs=args.silence_ms)
        _start_watchdog()
        # 等看门狗把 recording 置回 False（或超时兜底）
        deadline = time.time() + args.selftest + 30
        while recording and time.time() < deadline:
            time.sleep(0.1)
        # 给识别留一点时间把结果写出去
        time.sleep(2.0)
        return 0

    # ⚠️ 长按模式**不走 stdin 循环**。
    #
    #    原来所有模式都靠 `for line in sys.stdin` 保活。但 stdin 一旦 EOF，
    #    循环立刻结束、进程退出 —— **长按轮询跟着一起死**，表现就是
    #    "按住有反应一次，之后彻底没反应"。
    #    stdin 被重定向、被当后台任务启动、父进程没开管道，都会触发 EOF。
    #    长按模式本来就不需要上层的 START/STOP（自己轮询按键），
    #    所以直接常驻。
    if args.ptt:
        emit(kind="pttLoop", note="长按模式常驻中（不依赖 stdin），Ctrl+C 或杀进程退出")
        try:
            while True:
                time.sleep(0.5)
        except KeyboardInterrupt:
            pass
        return 0

    for line in sys.stdin:
        cmd = line.strip().upper()
        if not cmd:
            continue

        if cmd == "QUIT":
            break

        if cmd == "START":
            if recording:
                continue
            chunks = []
            while not q.empty():
                try:
                    q.get_nowait()
                except Exception:
                    break
            recording = True
            started_at = time.time()
            emit(kind="recording")
            # ⚠️ 关键：按一下就开始录，然后**自动停**。
            #
            # 为什么不做成「按一下开始、再按一下停止」：
            #   Electron 的 globalShortcut **只有按下事件，没有松开**，
            #   而 Windows 按住键会**重复发 keydown**。于是 toggle 式会变成
            #   开始/停止/开始/停止…（实测 begin/end 间隔只有 30~150ms）。
            #   改成「一次触发 + 自动停」之后，重复按多少次都无所谓。
            _start_watchdog()
            continue

        if cmd == "STOP":
            if not recording:
                emit(kind="empty", reason="not-recording")
                continue
            recording = False
            dur_ms = int((time.time() - started_at) * 1000)

            # 把回调线程投进来的块搬出来
            while not q.empty():
                try:
                    chunks.append(q.get_nowait())
                except Exception:
                    break

            if dur_ms < args.min_ms or not chunks:
                emit(kind="empty", reason="too-short", ms=dur_ms)
                continue

            audio = np.concatenate(chunks, axis=0).flatten()
            rms = float(np.sqrt(np.mean(audio ** 2))) if audio.size else 0.0

            # 全静音就别浪费一次推理
            if rms < 1e-5:
                emit(kind="empty", reason="silent", ms=dur_ms, rms=round(rms, 6))
                continue
            _transcribe(audio, "manual", dur_ms)
            continue

    try:
        stream.stop()
        stream.close()
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
