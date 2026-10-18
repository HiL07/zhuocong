"use strict";
/**
 * 叙事宿主（StoryHost）——把「剧本引擎」和「桌宠/UI/存档」接起来的那一层。
 *
 * 它**不 import electron**：桌宠怎么驱动（IPC/气泡/神态）由外部注入 `PetDriver`，
 * 存档目录由外部传入。这样它能被命令行直接跑（`tools/verify-story.mjs`），
 * 也能将来换成别的表现层（比如另一个 GUI）。
 *
 * 职责边界（很重要，别让它长胖）：
 *   · 管**会话**：当前跑哪个引擎、进行到哪、历史几句
 *   · 管**规则**：把 Beat 里的 state 合并进存档、把骰面/选项原样带给 UI
 *   · **不管**剧情：剧情全在引擎里
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.StoryHost = void 0;
const registry_1 = require("./registry");
const store_1 = require("./store");
const HISTORY_MAX = 40;
class StoryHost {
    engine = null;
    store = null;
    ctx = null;
    history = [];
    beat = null;
    o;
    constructor(o) {
        this.o = o;
    }
    list() {
        return (0, registry_1.listStories)();
    }
    view() {
        return {
            active: Boolean(this.engine),
            engineId: this.engine?.id ?? null,
            title: this.engine?.title ?? null,
            history: this.history.slice(-HISTORY_MAX),
            beat: this.beat,
            state: this.store ? this.store.snapshot() : {}
        };
    }
    emit() {
        try {
            this.o.onChange?.(this.view());
        }
        catch {
            /* UI 回调失败不该打断剧情 */
        }
    }
    /** 记一拍进历史，并把表现层的动作做掉 */
    apply(beat) {
        this.beat = beat;
        this.history.push({ speaker: beat.speaker, text: beat.text, roll: beat.roll });
        if (this.history.length > HISTORY_MAX)
            this.history.splice(0, this.history.length - HISTORY_MAX);
        // 表现：先神态/表情，再说话（顺序反了会出现"先出声后变脸"）
        try {
            const pet = this.o.pet;
            if (beat.mood)
                pet.mood(beat.mood);
            if (beat.expr)
                pet.expr(beat.expr, beat.exprSecs);
            pet.say(beat.text, { speaker: beat.speaker });
        }
        catch {
            /* 桌宠不在（比如无窗口的运行环境）也不该中断剧情 */
        }
        // 状态增量合并进存档并立即落盘
        if (beat.state && this.store) {
            for (const [k, v] of Object.entries(beat.state)) {
                const cur = this.store.get(k, undefined);
                // 一级 key 是对象就浅合并（`bag`/`player`），否则直接覆盖
                if (cur && typeof cur === 'object' && v && typeof v === 'object' && !Array.isArray(v)) {
                    this.store.set(k, { ...cur, ...v });
                }
                else {
                    this.store.set(k, v);
                }
            }
            this.store.save();
        }
        this.emit();
        return beat;
    }
    ensureContext() {
        if (!this.engine || !this.store)
            throw new Error('故事还没开始（先 startStory）');
        if (this.ctx)
            return this.ctx;
        const random = this.o.random ?? Math.random;
        this.ctx = {
            rng: {
                roll: (sides, count = 1) => Array.from({ length: Math.max(1, count) }, () => 1 + Math.floor(random() * Math.max(2, sides)))
            },
            state: this.store,
            pet: this.o.pet,
            log: (m) => console.info('[story]', m)
        };
        return this.ctx;
    }
    /** 开一个新剧本（或切到另一个） */
    async start(engineId, opts = {}) {
        const mod = (0, registry_1.findStory)(engineId);
        if (!mod)
            throw new Error(`没有这个剧本：${engineId}`);
        const makeStore = this.o.makeStore ?? ((id) => new store_1.FileStateStore(id, this.o.root));
        this.store = makeStore(engineId);
        if (opts.reset)
            this.store.reset();
        this.engine = mod.create();
        this.ctx = null;
        this.history = [];
        this.beat = null;
        const beat = await this.engine.start(this.ensureContext());
        this.apply(beat);
        return this.view();
    }
    /** 继续（不重新开）：读已有存档跑 start() */
    async resume(engineId) {
        return this.start(engineId);
    }
    async say(text) {
        if (!this.engine)
            throw new Error('故事还没开始（先 startStory）');
        const t = String(text ?? '').trim();
        if (!t)
            return this.view();
        // 玩家的话也记进历史（否则面板里看不到自己说了什么）
        this.history.push({ speaker: '我', text: t });
        const beat = await this.engine.say(t, this.ensureContext());
        this.apply(beat);
        return this.view();
    }
    async choose(choiceId) {
        if (!this.engine)
            throw new Error('故事还没开始（先 startStory）');
        this.history.push({ speaker: '我', text: `（选择：${choiceId}）` });
        const beat = await this.engine.choose(choiceId, this.ensureContext());
        this.apply(beat);
        return this.view();
    }
    stop() {
        this.engine = null;
        this.store = null;
        this.ctx = null;
        this.history = [];
        this.beat = null;
        this.emit();
    }
}
exports.StoryHost = StoryHost;
