"use strict";
/**
 * TtsManager —— 对上层只暴露两件事：`speak(text)` 和 `stop()`。
 *
 * 它负责：
 *   1. 选引擎（`config.tts.engine`），**gpt-sovits 挂了自动回退 edge**（用户明确要求"保底"）
 *   2. 文本预处理（`polish`：去元气/断句/停顿）+ 长度上限
 *   3. 缓存（同一句第二次 0ms）
 *   4. 把音频交给渲染层播放，并跟踪 id 以便打断
 *
 * 它**不做**：播放（渲染层的 `<audio>`）、口型（渲染层按音频时长驱动 `talk()`）、
 *          消息路由（谁该说什么，由 index.ts 决定）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TtsManager = void 0;
const node_path_1 = require("node:path");
const logger_1 = require("../logger");
const cache_1 = require("./cache");
const engines_1 = require("./engines");
const polish_1 = require("./polish");
const MIME = { mp3: 'audio/mpeg', wav: 'audio/wav' };
class TtsManager {
    cfg;
    cache;
    edge;
    gpt;
    lg;
    /** 每句话的序号：渲染层用它回报"放完了"，主进程据此忽略过期事件 */
    seq = 0;
    constructor(cfg, deps) {
        this.cfg = cfg;
        this.lg = deps.log ?? ((ev, data) => (0, logger_1.log)(ev, data));
        this.cache = new cache_1.AudioCache(deps.root, cfg.cacheMB);
        this.edge = new engines_1.EdgeEngine({
            python: deps.python,
            script: (0, node_path_1.join)(deps.root, 'tools', 'tts.py'),
            libs: (0, node_path_1.join)(deps.root, '.local', 'pylibs'),
            voice: cfg.voice,
            rate: cfg.rate,
            pitch: cfg.pitch,
            polish: cfg.polish
        }, this.lg);
        this.gpt = new engines_1.GptSoVitsEngine({
            url: cfg.gptSovits.url,
            // ⚠️ 必须绝对路径：GPT-SoVITS 服务是按**它自己的 CWD** 解析 ref_audio_path 的，
            //    传相对路径会报 `assets/ref/ref_audio.wav not exists`（实测踩到）。
            refAudio: cfg.gptSovits.refAudio
                ? ((0, node_path_1.isAbsolute)(cfg.gptSovits.refAudio) ? cfg.gptSovits.refAudio : (0, node_path_1.join)(deps.root, cfg.gptSovits.refAudio))
                : '',
            promptText: cfg.gptSovits.promptText,
            promptLang: cfg.gptSovits.promptLang,
            textLang: cfg.gptSovits.textLang,
            emotionPrefix: cfg.gptSovits.emotionPrefix,
            temperature: cfg.gptSovits.temperature,
            topK: cfg.gptSovits.topK,
            topP: cfg.gptSovits.topP,
            speed: cfg.gptSovits.speed,
            sampleSteps: cfg.gptSovits.sampleSteps,
            textSplit: cfg.gptSovits.textSplit,
            fragmentInterval: cfg.gptSovits.fragmentInterval,
            timeoutMs: cfg.gptSovits.timeoutMs
        }, this.lg);
    }
    get enabled() {
        return this.cfg.enabled;
    }
    get engine() {
        return this.cfg.engine;
    }
    /** 探活（给托盘/诊断用）：gpt-sovits 时返回服务是否在跑 */
    async probe() {
        if (this.cfg.engine !== 'gpt-sovits')
            return { engine: 'edge', ready: true };
        const ok = await this.gpt.probe(true);
        return { engine: 'gpt-sovits', ready: ok, detail: ok ? undefined : '服务没起或端口不对' };
    }
    /**
     * 合成一段话。**不播放** —— 返回音频与 mime，由调用方决定怎么发。
     * 注意：这里已经做了"引擎回退"，所以 result.engine 可能和 cfg.engine 不同。
     */
    async synth(text) {
        if (!this.cfg.enabled)
            return { ok: false, error: 'tts 已关闭' };
        const wantGpt = this.cfg.engine === 'gpt-sovits';
        // GPT-SoVITS 默认**不做**"演戏"改写：它自己的韵律已经不错，
        // 而"短句→省略号"会让它拉出长停顿（实测 11.37s vs 7.51s，听感是"中间慢出电音"）。
        const usePolish = this.cfg.polish && (!wantGpt || this.cfg.gptSovits.polish);
        const spoken = (0, polish_1.prepareForTts)(text, { maxChars: this.cfg.maxChars, polish: usePolish });
        if (!spoken || !/[\p{L}\p{N}]/u.test(spoken))
            return { ok: false, error: '没有可念的内容', text: spoken };
        const key = (0, cache_1.cacheKey)([
            this.cfg.engine, this.cfg.voice, this.cfg.rate, this.cfg.pitch,
            this.cfg.gptSovits.speed, this.cfg.gptSovits.temperature, spoken
        ]);
        const ext = wantGpt ? 'wav' : 'mp3';
        const hit = this.cache.get(key, ext);
        if (hit) {
            this.lg('tts.cacheHit', { bytes: hit.length, chars: spoken.length });
            return { ok: true, engine: this.cfg.engine, cacheHit: true, ms: 0, chars: spoken.length,
                text: spoken, audio: hit, mime: MIME[ext], id: ++this.seq };
        }
        let res;
        if (wantGpt) {
            res = await this.gpt.synth(spoken);
            if (!res.ok) {
                // ← 用户要求的"保底"：GPT-SoVITS 挂了就退回 edge，不让桌宠哑掉
                this.lg('tts.fallback', { from: 'gpt-sovits', reason: res.error });
                res = await this.edge.synth(spoken, this.cfg.timeoutMs);
            }
        }
        else {
            res = await this.edge.synth(spoken, this.cfg.timeoutMs);
        }
        if (!res.ok || !res.audio) {
            this.lg('tts.failed', { engine: res.engine ?? this.cfg.engine, error: res.error });
            return { ok: false, error: res.error, engine: res.engine, text: spoken };
        }
        const usedExt = res.ext ?? ext;
        this.cache.put(key, usedExt, res.audio);
        this.lg('tts.synth', {
            engine: res.engine, bytes: res.audio.length, ms: res.ms,
            firstAudioMs: res.firstAudioMs ?? null, chars: spoken.length
        });
        return {
            ok: true, engine: res.engine, ms: res.ms, chars: spoken.length, text: spoken,
            audio: res.audio, mime: MIME[usedExt], id: ++this.seq
        };
    }
    stats() {
        const s = this.cache.sizeInfo();
        return { engine: this.cfg.engine, cache: { files: s.files, bytes: s.bytes } };
    }
    /**
     * 预热：合成一句不会被用到的短语。
     *
     * 为什么必须做：本地克隆模型**第一次推理要 8~9 秒**（权重/显存预热），
     * 之后每句才 3~5 秒。路演现场第一句话就要等 10 秒，观感非常差。
     * 应用启动时在后台跑一次，把这段冷启动挪到用户看不见的地方。
     */
    async warmup() {
        const t0 = Date.now();
        try {
            const r = await this.synth('预热，请稍候。');
            const ms = Date.now() - t0;
            this.lg('tts.warmup', { ok: r.ok, ms, engine: r.engine });
            return { ok: r.ok, ms };
        }
        catch {
            return { ok: false, ms: Date.now() - t0 };
        }
    }
    /**
     * 预置常用短句（命中缓存后 **0 ms**）。
     * 桌宠高频台词其实就那几句，提前合成好，说的时候几乎即时。
     */
    async preseed(phrases) {
        let n = 0;
        for (const p of phrases) {
            try {
                const r = await this.synth(p);
                if (r.ok)
                    n++;
            }
            catch {
                /* 单句失败不影响其它 */
            }
        }
        this.lg('tts.preseed', { done: n, total: phrases.length });
        return n;
    }
    dispose() {
        this.edge.dispose();
    }
}
exports.TtsManager = TtsManager;
