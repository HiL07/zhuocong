"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatSession = void 0;
/** 预算 block 时用的本地固定文案（不发请求，不花钱） */
const BLOCKED_REPLY = '今天的话费额度用完啦，明天再聊吧～';
/** degrade 时把 maxTokens 收到多少 */
const DEGRADE_MAX_TOKENS = 128;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class ChatSession {
    d;
    abort = null;
    inFlight = false;
    // ---- 逐字限速用 ----
    queue = [];
    drainer = null;
    drainResolve = null;
    constructor(deps) {
        this.d = deps;
    }
    get busy() {
        return this.inFlight;
    }
    /** 取消当前这一轮（没在跑就是空操作） */
    cancel() {
        this.abort?.abort(new Error('用户取消'));
    }
    // ---------- 逐字限速 ----------
    /** 启动抽水泵（幂等）。每个 tick 吐一个字。 */
    startDrain() {
        if (this.drainer)
            return;
        const ms = Math.max(8, Math.round(1000 / Math.max(1, this.d.typewriterCps)));
        this.drainer = setInterval(() => {
            const ch = this.queue.shift();
            if (ch !== undefined) {
                this.d.onDelta(ch);
            }
            else if (this.drainResolve) {
                // 队列空了：通知等待者
                const r = this.drainResolve;
                this.drainResolve = null;
                r();
            }
        }, ms);
    }
    stopDrain() {
        if (this.drainer) {
            clearInterval(this.drainer);
            this.drainer = null;
        }
        this.drainResolve = null;
        this.queue = [];
    }
    /** 等队列里的字全部吐完 */
    drained() {
        if (!this.queue.length)
            return Promise.resolve();
        return new Promise((res) => {
            this.drainResolve = res;
        });
    }
    feed(text) {
        for (const ch of text)
            this.queue.push(ch);
        this.startDrain();
    }
    // ---------- 主流程 ----------
    /**
     * 发一条用户消息并流式取回回复。
     * 同一时间只允许一轮；重复调用直接返回。
     *
     * `opts.image` 是一张图的 **data URL**（屏幕感知用）。给了它就把**最后一条用户消息**
     * 换成图文数组，并**按次**把模型换成 `visionModel` —— 文本对话仍然走配置里的模型。
     * ⚠️ 图片只出现在**这一次请求**里，不进历史（历史里只留一句"（附一张屏幕截图）"）：
     *   否则每一轮都会把旧截图重复上传，token 白烧（一张图 384 token）。
     */
    async send(text, opts) {
        const t = text.trim();
        if (!t || this.inFlight)
            return;
        if (opts?.image && !this.d.visionModel) {
            this.d.onError('没有配置多模态模型，看不了屏幕（config.vision.model）');
            return;
        }
        this.inFlight = true;
        const t0 = Date.now();
        let talkingEmitted = false;
        /** 首字到达时的状态切换：要等够 minThinkingMs，且不能在结束后才补发 */
        const toTalking = () => {
            if (talkingEmitted)
                return;
            talkingEmitted = true;
            this.d.onState('talking');
        };
        try {
            // 用户的话先落记录（无论后面成不成功，用户说过的话都该留着）
            this.d.log.append({ who: 'user', text: t });
            // ---- 预算熔断 ----
            const verdict = this.d.budget.check();
            if (verdict === 'block') {
                const snap = this.d.budget.snapshot();
                this.d.log.append({
                    who: 'error',
                    text: BLOCKED_REPLY,
                    meta: `预算已用 ${(snap.ratio * 100).toFixed(1)}%，本月不再发请求`
                });
                // 走同一套逐字路径，视觉上和正常回复一致
                this.feed(BLOCKED_REPLY);
                this.d.onFirstToken(0);
                await this.drained();
                const totalMs = Date.now() - t0;
                this.d.onState('idle');
                this.d.onDone({ text: BLOCKED_REPLY, totalMs, blocked: true });
                return;
            }
            // ---- 组装消息 ----
            // 每轮都解析一次：人格可能刚被设置窗改过，状态也可能变了
            const sysPrompt = typeof this.d.systemPrompt === 'function' ? this.d.systemPrompt() : this.d.systemPrompt;
            const messages = [{ role: 'system', content: sysPrompt }];
            for (const m of this.d.log.recentMessages(this.d.historyLimit)) {
                messages.push({ role: m.role, content: m.content });
            }
            // 屏幕感知：把**最后一条**（刚 append 的用户话）换成图文数组
            if (opts?.image) {
                const last = messages[messages.length - 1];
                if (last && last.role === 'user') {
                    last.content = [
                        { type: 'text', text: t },
                        { type: 'image_url', image_url: { url: opts.image } }
                    ];
                }
            }
            // degrade：**真的**收紧 maxTokens（通过 provider 的单次覆盖参数）。
            // 不做这一步的话，"降级"就只是个状态字符串，预算保护形同虚设。
            const chatOpts = opts?.image
                ? { model: this.d.visionModel, ...(verdict === 'degrade' ? { maxTokens: DEGRADE_MAX_TOKENS } : {}) }
                : verdict === 'degrade'
                    ? { maxTokens: DEGRADE_MAX_TOKENS }
                    : undefined;
            this.d.onState('thinking');
            this.abort = new AbortController();
            const res = await this.d.provider.chat(messages, {
                onDelta: (delta) => {
                    this.feed(delta);
                },
                onFirstToken: (ms) => {
                    // 网络首字到了，但**先别切神态** —— 等 minThinkingMs
                    const wait = Math.max(0, this.d.minThinkingMs - (Date.now() - t0));
                    if (wait > 0)
                        setTimeout(toTalking, wait);
                    else
                        toTalking();
                    this.d.onFirstToken(ms);
                }
            }, this.abort.signal, chatOpts);
            // ---- 等积压的字吐完，再收尾 ----
            await this.drained();
            // 极短回复（比如只回一个字）可能在 minThinkingMs 之前就结束。
            // ⚠️ 这里**不能直接切 talking** —— 那会把最短思考时长整个覆盖掉
            //    （实测：600ms 的设定被 45ms 就绕过了）。
            //    正确做法是**补足剩余时间**再切。
            if (!talkingEmitted && res.text) {
                const wait = Math.max(0, this.d.minThinkingMs - (Date.now() - t0));
                if (wait > 0)
                    await sleep(wait);
                toTalking();
            }
            // 让可能已排队的 setTimeout(toTalking) 先跑完，避免它落在 idle 之后
            await sleep(0);
            this.d.log.append({ who: 'pet', text: res.text });
            if (res.usage)
                this.d.budget.record(res.usage);
            this.d.onState('idle');
            const totalMs = Date.now() - t0;
            this.d.onDone({
                text: res.text,
                // 用**网络首字**而不是"第一个字被画出来的时刻"：
                // 验收指标「首字 < 2s」衡量的是模型响应速度，
                // 加上逐字限速的延迟会把这指标污染掉（限速是显示层的事）。
                ...(res.firstTokenMs !== undefined ? { firstTokenMs: res.firstTokenMs } : {}),
                totalMs,
                ...(verdict === 'degrade' ? { degraded: true } : {})
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.d.onState('error');
            this.d.log.append({ who: 'error', text: '出错了：' + msg });
            this.d.onError(msg);
        }
        finally {
            this.stopDrain();
            this.inFlight = false;
            this.abort = null;
        }
    }
}
exports.ChatSession = ChatSession;
