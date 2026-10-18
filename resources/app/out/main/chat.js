"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatLog = void 0;
/**
 * 聊天记录：**归属主进程**，不放在渲染层 DOM 里。
 *
 * 为什么不能只存在渲染层（这是实测踩到的 bug）：
 *   聊天窗关闭后如果销毁，下次打开是全新的渲染层，DOM 里的消息全没了。
 *   而且步 5 开始主进程要往两个窗口广播 chunk，它本来就必须持有会话上下文。
 *   所以「记录归主进程」不是权宜之计，是正确架构。
 *
 * 为什么不用 preventDefault 拦关闭来保活窗口：
 *   那会**卡住退出**。本项目的退出走 `app.exit(0)`（`pet:quit` / 菜单 / 热键
 *   三条路径），而 `app.exit()` **不触发** `before-quit`，
 *   拿不到"正在退出"的时机去放行关闭 —— 一旦拦错，用户就退不出程序了。
 *
 * 本文件**不 import electron**（和 budget / providers 一样），
 * 只依赖标准 Node，因此可以被命令行独立验证。
 */
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
/** 最多保留多少条。个人自用，不必无限增长。 */
const DEFAULT_MAX = 200;
class ChatLog {
    entries = [];
    file;
    max;
    constructor(opts) {
        this.max = opts.max ?? DEFAULT_MAX;
        const dir = (0, node_path_1.join)(opts.root, '.local');
        (0, node_fs_1.mkdirSync)(dir, { recursive: true });
        this.file = (0, node_path_1.join)(dir, 'chat-history.json');
        this.load();
    }
    get filePath() {
        return this.file;
    }
    /** 全部记录（返回副本，外部改不到内部状态） */
    all() {
        return this.entries.slice();
    }
    get length() {
        return this.entries.length;
    }
    /**
     * 追加一条。
     * 超过上限时**从头丢弃**（保留最近的对话，符合聊天场景）。
     */
    append(e) {
        const entry = { who: e.who, text: e.text, at: e.at ?? Date.now() };
        if (e.meta !== undefined)
            entry.meta = e.meta;
        this.entries.push(entry);
        if (this.entries.length > this.max) {
            this.entries.splice(0, this.entries.length - this.max);
        }
        this.persist();
        return entry;
    }
    clear() {
        this.entries = [];
        this.persist();
    }
    /** 取最近 n 条转为 LLM 消息（步 5 会用到） */
    recentMessages(n) {
        const out = [];
        for (const e of this.entries.slice(-n)) {
            if (e.who === 'user')
                out.push({ role: 'user', content: e.text });
            else if (e.who === 'pet')
                out.push({ role: 'assistant', content: e.text });
        }
        return out;
    }
    load() {
        try {
            if (!(0, node_fs_1.existsSync)(this.file))
                return;
            const raw = JSON.parse((0, node_fs_1.readFileSync)(this.file, 'utf8'));
            if (!Array.isArray(raw))
                return;
            this.entries = raw
                .filter((e) => {
                if (typeof e !== 'object' || e === null)
                    return false;
                const o = e;
                return typeof o.text === 'string' && typeof o.who === 'string' && typeof o.at === 'number';
            })
                .slice(-this.max);
        }
        catch {
            // 文件损坏就当空的，不要让聊天窗打不开
            this.entries = [];
        }
    }
    persist() {
        try {
            (0, node_fs_1.writeFileSync)(this.file, JSON.stringify(this.entries, null, 2), 'utf8');
        }
        catch {
            /* 写失败不影响主流程 */
        }
    }
}
exports.ChatLog = ChatLog;
