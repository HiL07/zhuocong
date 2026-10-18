"use strict";
/**
 * DeepSeek 流式实现（OpenAI 兼容的 SSE）。
 *
 * 三个必须记住的坑（都写在对应代码旁边了）：
 *   1. **思考模式默认开启**。deepseek-flash 不显式关掉会走 reasoning，
 *      实测 completion_tokens 从 22 涨到 120。所以请求体里显式发
 *      `thinking: { type: 'disabled' }`。
 *   2. **流式默认不返回 usage**。必须发 `stream_options: { include_usage: true }`，
 *      否则拿不到 token 数，预算熔断就没数据可用。
 *   3. **SSE 分片会切断行**。一个 TCP chunk 可能停在半行 JSON 上，
 *      所以必须自己缓冲、按 \n 切、只处理完整的 `data:` 行。
 *
 * 本文件**不许 import electron** —— 它要能在命令行里独立验证。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeepSeekProvider = void 0;
exports.createProvider = createProvider;
/** 从 SSE 的一行里取出 payload；不是 data 行则返回 null。 */
function sseData(line) {
    const t = line.trim();
    if (!t.startsWith('data:'))
        return null;
    return t.slice(5).trim();
}
class DeepSeekProvider {
    name = 'deepseek';
    model;
    o;
    constructor(o) {
        this.o = o;
        this.model = o.model;
    }
    buildBody(messages, stream, maxTokensOverride, modelOverride) {
        const body = {
            // 按次覆盖：屏幕感知那一轮换成多模态模型（deepseek-v4-flash-vision-exp），
            // 其余对话仍用配置里的模型。messages 里的 content 允许是图文数组，原样透传即可。
            model: modelOverride ?? this.o.model,
            messages,
            stream,
            temperature: this.o.temperature,
            // degrade 时用覆盖值收紧上限
            max_tokens: maxTokensOverride ?? this.o.maxTokens
        };
        if (stream) {
            // 坑 2：不发这个就拿不到 usage
            body.stream_options = { include_usage: true };
        }
        if (!this.o.thinking) {
            // 坑 1：DeepSeek 默认开思考模式。显式关掉，否则 token 消耗翻好几倍。
            // 注意这是 DeepSeek 特有的字段，不是 OpenAI 标准字段。
            body.thinking = { type: 'disabled' };
        }
        return body;
    }
    async chat(messages, cb, signal, opts) {
        const t0 = Date.now();
        // ⚠️ 每次都现取 Key，不要缓存到 this：
        //    设置窗里刚填的 Key 必须**立刻**能用，否则用户"填了还要重启"，
        //    还会看到"未配置 API Key"这种莫名报错（2026-10-18 用户实测）。
        const apiKey = typeof this.o.apiKey === 'function' ? this.o.apiKey() : this.o.apiKey;
        if (!apiKey) {
            throw new Error('未配置 API Key（去 设置 → 模型 里填，或写进 .env 的 DEEPSEEK_API_KEY）');
        }
        const url = this.o.baseUrl.replace(/\/+$/, '') + '/chat/completions';
        // 超时用 AbortController 自己控，和外部传入的 signal 合并
        const ctl = new AbortController();
        const timeoutMs = this.o.timeoutMs ?? 60_000;
        const timer = setTimeout(() => ctl.abort(new Error('请求超时')), timeoutMs);
        const onOuterAbort = () => ctl.abort(signal?.reason);
        if (signal) {
            if (signal.aborted)
                ctl.abort(signal.reason);
            else
                signal.addEventListener('abort', onOuterAbort, { once: true });
        }
        let text = '';
        let usage;
        let finishReason;
        let firstTokenMs;
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                    Accept: 'text/event-stream'
                },
                body: JSON.stringify(this.buildBody(messages, true, opts?.maxTokens, opts?.model)),
                signal: ctl.signal
            });
            if (!res.ok) {
                // 把服务端的错误正文带出来，否则只有一个状态码很难查
                const detail = await res.text().catch(() => '');
                throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? ' — ' + detail.slice(0, 300) : ''}`);
            }
            if (!res.body)
                throw new Error('响应没有 body，无法读取流');
            // 坑 3：自己缓冲，只处理完整的行
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                buf += decoder.decode(value, { stream: true });
                let nl;
                while ((nl = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, nl);
                    buf = buf.slice(nl + 1);
                    const payload = sseData(line);
                    if (payload === null)
                        continue;
                    if (payload === '[DONE]')
                        continue;
                    let json;
                    try {
                        json = JSON.parse(payload);
                    }
                    catch {
                        // 半行 JSON 或服务端心跳，跳过而不是崩掉整个流
                        continue;
                    }
                    if (json.usage) {
                        usage = {
                            in: json.usage.prompt_tokens ?? 0,
                            out: json.usage.completion_tokens ?? 0,
                            cached: json.usage.prompt_cache_hit_tokens
                        };
                    }
                    const choice = json.choices?.[0];
                    if (!choice)
                        continue;
                    if (choice.finish_reason)
                        finishReason = choice.finish_reason;
                    const delta = choice.delta?.content;
                    if (delta) {
                        if (firstTokenMs === undefined) {
                            firstTokenMs = Date.now() - t0;
                            cb.onFirstToken?.(firstTokenMs);
                        }
                        text += delta;
                        cb.onDelta(delta);
                    }
                }
            }
            return { text, usage, finishReason, firstTokenMs, totalMs: Date.now() - t0 };
        }
        finally {
            clearTimeout(timer);
            if (signal)
                signal.removeEventListener('abort', onOuterAbort);
        }
    }
}
exports.DeepSeekProvider = DeepSeekProvider;
/** 按配置造一个 provider。目前只有 DeepSeek。 */
function createProvider(o) {
    return new DeepSeekProvider(o);
}
