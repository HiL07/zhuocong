"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DragDiag = void 0;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
class DragDiag {
    dir;
    session = 0;
    step = 0;
    enabled;
    constructor(root, enabled) {
        this.enabled = enabled;
        this.dir = (0, node_path_1.join)(root, '.selfcheck', 'drag');
        if (enabled)
            (0, node_fs_1.mkdirSync)(this.dir, { recursive: true });
    }
    get on() {
        return this.enabled;
    }
    /** 一次拖动开始。返回本次会话号，用于文件名。 */
    start(win, raw, s, offset, pointer) {
        if (!this.enabled)
            return;
        this.session += 1;
        this.step = 0;
        const b = win.getBounds();
        this.write('start', {
            raw, s, offset, pointer,
            boundsBefore: b,
            winSize: { w: b.width, h: b.height },
            contentBounds: win.getContentBounds()
        });
        void this.shot(win, 'start');
    }
    /** 每次移动。 */
    move(win, n, raw, dip, target) {
        if (!this.enabled)
            return;
        this.step = n;
        const b = win.getBounds();
        // 只在窗口尺寸变了、或者我们要求的位置没生效时多记一点上下文；
        // 每一步都截屏太重，改由调用方按间隔决定。
        this.write('move', {
            n, raw, dip, target,
            boundsAfter: b,
            winSize: { w: b.width, h: b.height },
            /** 目标位置与实际位置的偏差：非 0 说明被系统夹住了 */
            delta: { x: b.x - target.x, y: b.y - target.y }
        });
    }
    /** 渲染层报告的视口信息：精灵到底画在哪、多大。 */
    viewport(msg) {
        if (!this.enabled)
            return;
        this.write('viewport', msg);
    }
    end(win, moved) {
        if (!this.enabled)
            return;
        const b = win.getBounds();
        this.write('end', { moved, bounds: b, winSize: { w: b.width, h: b.height } });
        void this.shot(win, 'end');
    }
    /** 按间隔截图，避免每帧都抓。 */
    screenshot(win, every) {
        if (!this.enabled)
            return;
        if (this.step > 0 && this.step % every === 0)
            void this.shot(win, 'move');
    }
    async shot(win, tag) {
        try {
            if (win.isDestroyed() || win.webContents.isDestroyed())
                return;
            const img = await win.capturePage();
            const f = (0, node_path_1.join)(this.dir, `${this.session}-${String(this.step).padStart(4, '0')}-${tag}.png`);
            (0, node_fs_1.writeFileSync)(f, img.toPNG());
        }
        catch {
            /* 截图失败不影响拖动本身 */
        }
    }
    write(kind, data) {
        try {
            (0, node_fs_1.appendFileSync)((0, node_path_1.join)(this.dir, 'samples.jsonl'), JSON.stringify({ t: Date.now(), session: this.session, step: this.step, kind, ...data }) + '\n', 'utf8');
        }
        catch {
            /* 写不进去就算了，不要因为诊断把功能搞挂 */
        }
    }
}
exports.DragDiag = DragDiag;
