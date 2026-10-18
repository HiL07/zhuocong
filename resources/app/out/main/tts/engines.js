"use strict";
/**
 * TTS 引擎实现：`edge`（现在能用）与 `gpt-sovits`（本机装好后可用）。
 *
 * 两者都只回答一个问题："这句话 → 一段音频字节"。
 * 上层（`index.ts` 的 TtsManager）负责选引擎、缓存、回退、驱动播放和口型。
 *
 * 为什么 gpt-sovits 用 **HTTP 直连**而不是再 spawn 个 Python：
 *   它的服务（api_v2.py）本来就是常驻 HTTP 服务，多起一个进程只是多一层故障点。
 *   而且 Node 18+ 自带 fetch，不需要额外依赖。
 *
 * ⚠️ edge 走 **长驻 Python 子进程 + JSON 行**（tools/tts.py --stdio）：
 *   每次说话重启 Python 会多 300~500ms，聊天会明显变慢。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GptSoVitsEngine = exports.EdgeEngine = void 0;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
class EdgeEngine {
    child = null;
    pending = new Map();
    seq = 0;
    lineBuf = '';
    o;
    log;
    constructor(o, log) {
        this.o = o;
        this.log = log;
    }
    ensure() {
        if (this.child && !this.child.killed)
            return this.child;
        if (!(0, node_fs_1.existsSync)(this.o.script)) {
            this.log('tts.edge.noScript', { script: this.o.script });
            return null;
        }
        try {
            // ⚠️ `--rate=-15%` 必须用 `=` 连写：argparse 会把 `-15%` 当成"另一个选项"，
            //    报 `argument --rate: expected one argument`（探针实测踩到，桥直接 exit 2）。
            const args = [
                this.o.script, '--stdio', `--libs=${this.o.libs}`,
                `--voice=${this.o.voice}`, `--rate=${this.o.rate}`, `--pitch=${this.o.pitch}`
            ].concat(this.o.polish ? ['--polish'] : []);
            const child = (0, node_child_process_1.spawn)(this.o.python, args, {
                windowsHide: true,
                // ⚠️ 必须注入 PYTHONIOENCODING：Windows 子进程默认按控制台代码页（cp936）解码 stdin，
                //    中文会变成代理字符（实测 'utf-8' codec can't encode character '\udc80'）。
                //    桥那侧也 reconfigure 成 utf-8，两边一起才彻底。
                env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
                stdio: ['pipe', 'pipe', 'pipe']
            });
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk) => this.onData(chunk));
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', (s) => {
                const t = String(s).trim();
                if (t)
                    this.log('tts.edge.stderr', { line: t.slice(0, 200) });
            });
            child.on('exit', (code) => {
                this.log('tts.edge.exit', { code });
                this.child = null;
                for (const [, p] of this.pending) {
                    clearTimeout(p.timer);
                    p.resolve({ ok: false, error: `bridge exited (${code})` });
                }
                this.pending.clear();
            });
            this.child = child;
            this.log('tts.edge.spawned', { pid: child.pid });
            return child;
        }
        catch (e) {
            this.log('tts.edge.spawnFailed', { error: String(e).slice(0, 200) });
            return null;
        }
    }
    onData(chunk) {
        this.lineBuf += chunk;
        let nl;
        while ((nl = this.lineBuf.indexOf('\n')) >= 0) {
            const line = this.lineBuf.slice(0, nl).trim();
            this.lineBuf = this.lineBuf.slice(nl + 1);
            if (!line)
                continue;
            let msg;
            try {
                msg = JSON.parse(line);
            }
            catch {
                continue;
            }
            const id = Number(msg.id);
            const p = this.pending.get(id);
            if (!p)
                continue;
            this.pending.delete(id);
            clearTimeout(p.timer);
            if (msg.ok && msg.mp3) {
                p.resolve({ ok: true, audio: Buffer.from(msg.mp3, 'base64'), ext: 'mp3',
                    ms: msg.totalMs, firstAudioMs: msg.firstAudioMs, engine: 'edge' });
            }
            else {
                p.resolve({ ok: false, error: String(msg.error || 'edge 合成失败'), engine: 'edge' });
            }
        }
    }
    synth(text, timeoutMs = 20000) {
        const child = this.ensure();
        if (!child)
            return Promise.resolve({ ok: false, error: 'edge 桥不可用' });
        const id = ++this.seq;
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                resolve({ ok: false, error: 'edge 超时', engine: 'edge' });
            }, timeoutMs);
            this.pending.set(id, { resolve, timer });
            try {
                child.stdin.write(JSON.stringify({ id, text }) + '\n');
            }
            catch (e) {
                clearTimeout(timer);
                this.pending.delete(id);
                resolve({ ok: false, error: String(e).slice(0, 200), engine: 'edge' });
            }
        });
    }
    dispose() {
        try {
            this.child?.kill();
        }
        catch { /* ignore */ }
        this.child = null;
    }
}
exports.EdgeEngine = EdgeEngine;
class GptSoVitsEngine {
    schema = null;
    schemaAt = 0;
    o;
    log;
    constructor(o, log) {
        this.o = o;
        this.log = log;
    }
    /** 探活 + 读 openapi（缓存 60 秒，避免每次说话都探） */
    async probe(force = false) {
        const now = Date.now();
        if (!force && this.schema && now - this.schemaAt < 60_000)
            return true;
        try {
            const res = await fetch(this.o.url.replace(/\/+$/, '') + '/openapi.json', {
                signal: AbortSignal.timeout(3000)
            });
            if (!res.ok)
                throw new Error(`openapi HTTP ${res.status}`);
            const spec = await res.json();
            const paths = spec.paths || {};
            const keys = Object.keys(paths);
            const path = keys.find((p) => p.replace(/\//g, '') === 'tts') || keys.find((p) => p.includes('tts'));
            if (!path)
                throw new Error('openapi 里没有 tts 端点');
            const ops = paths[path];
            const method = ops.post ? 'post' : 'get';
            const op = ops[method];
            const params = {};
            const rb = op.requestBody || {};
            for (const [ct, s] of Object.entries(rb.content || {})) {
                let sch = s.schema || {};
                if (sch.$ref) {
                    const name = String(sch.$ref).split('/').pop() ?? '';
                    sch = (spec.components?.schemas?.[name] || {});
                }
                for (const [k, v] of Object.entries(sch.properties || {})) {
                    params[k] = { type: v.type, required: (sch.required || []).includes(k), ct };
                }
            }
            for (const p of op.parameters || []) {
                const pname = String(p?.name ?? '');
                if (pname) {
                    params[pname] = {
                        type: p?.schema?.type,
                        required: Boolean(p?.required),
                        ct: p?.in
                    };
                }
            }
            this.schema = { base: this.o.url.replace(/\/+$/, ''), path, method, params };
            this.schemaAt = now;
            this.log('tts.gpt.probed', { endpoint: path, method, params: Object.keys(params).length });
            return true;
        }
        catch (e) {
            this.schema = null;
            this.log('tts.gpt.probeFailed', { error: String(e).slice(0, 160) });
            return false;
        }
    }
    async synth(rawText) {
        if (!(await this.probe()))
            return { ok: false, error: 'GPT-SoVITS 服务没起', engine: 'gpt-sovits' };
        const sch = this.schema;
        if (!this.o.refAudio || !(0, node_fs_1.existsSync)(this.o.refAudio)) {
            return { ok: false, error: `参考音频不存在：${this.o.refAudio}`, engine: 'gpt-sovits' };
        }
        if (!this.o.promptText) {
            return { ok: false, error: '没填 prompt_text（参考音频里实际说的词）', engine: 'gpt-sovits' };
        }
        const text = this.o.emotionPrefix ? this.o.emotionPrefix + rawText : rawText;
        const want = {
            text,
            text_lang: this.o.textLang,
            ref_audio_path: this.o.refAudio,
            prompt_text: this.o.promptText,
            prompt_lang: this.o.promptLang,
            top_k: this.o.topK,
            top_p: this.o.topP,
            temperature: this.o.temperature,
            speed_factor: this.o.speed,
            speed: this.o.speed,
            sample_steps: this.o.sampleSteps,
            text_split_method: this.o.textSplit,
            fragment_interval: this.o.fragmentInterval,
            media_type: 'wav',
            streaming_mode: false
        };
        const payload = {};
        const alias = { speed: 'speed_factor', prompt_lang: 'prompt_language', text_lang: 'text_language' };
        for (const [k, v] of Object.entries(want)) {
            if (k in sch.params)
                payload[k] = v;
            else if (alias[k] && alias[k] in sch.params)
                payload[alias[k]] = v;
        }
        const missing = Object.entries(sch.params).filter(([k, m]) => m.required && !(k in payload)).map(([k]) => k);
        if (missing.length) {
            return { ok: false, error: '缺少必填参数: ' + missing.join(','), engine: 'gpt-sovits' };
        }
        const ct = Object.values(sch.params)[0]?.ct || 'application/json';
        const t0 = Date.now();
        try {
            let url = sch.base + sch.path;
            let body;
            const headers = {};
            // URLSearchParams 要 [string,string][]（Object.entries 推出来是 string[][]，TS 不认）
            const pairs = Object.entries(payload).map(([k, v]) => [k, String(v)]);
            if (sch.method === 'get') {
                url += '?' + new URLSearchParams(pairs).toString();
            }
            else if (ct.includes('json')) {
                headers['Content-Type'] = 'application/json';
                body = JSON.stringify(payload);
            }
            else {
                headers['Content-Type'] = 'application/x-www-form-urlencoded';
                body = new URLSearchParams(pairs).toString();
            }
            const res = await fetch(url, {
                method: sch.method.toUpperCase(),
                headers,
                body,
                signal: AbortSignal.timeout(this.o.timeoutMs)
            });
            if (!res.ok) {
                const detail = await res.text().catch(() => '');
                return { ok: false, error: `HTTP ${res.status} ${detail.slice(0, 160)}`, engine: 'gpt-sovits' };
            }
            const buf = Buffer.from(await res.arrayBuffer());
            if (!buf.length)
                return { ok: false, error: '返回空音频', engine: 'gpt-sovits' };
            return { ok: true, audio: buf, ext: 'wav', ms: Date.now() - t0, engine: 'gpt-sovits' };
        }
        catch (e) {
            return { ok: false, error: String(e).slice(0, 160), engine: 'gpt-sovits' };
        }
    }
}
exports.GptSoVitsEngine = GptSoVitsEngine;
