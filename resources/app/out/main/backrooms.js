"use strict";
/**
 * 《后室漫游：回到现实》宿主窗口。
 *
 * 设计取舍：**不改游戏、不重写剧情**，只是给它开一个窗口 + 一条事件通道。
 * 游戏本体是单文件 HTML（`assets/games/backrooms-return.html`，2672 行，零外部依赖），
 * 它自己已有：4 屏界面、存档（localStorage 单 key）、三种结局、以及我们加的 7 个 `emit()` 出口。
 *
 * ⚠️ 必须用 `app://pet/game/…` 加载，**不能用 `file://`**：
 *    游戏把存档写在 localStorage，`file://` 与 `app://` 是**不同 origin**，
 *    换加载方式用户的进度就会"消失"。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BackroomsWindow = void 0;
exports.backroomsIcon = backroomsIcon;
const electron_1 = require("electron");
const node_path_1 = require("node:path");
const logger_1 = require("./logger");
const URL_PATH = 'app://pet/game/backrooms-return.html';
class BackroomsWindow {
    win = null;
    deps;
    handler = null;
    constructor(deps) {
        this.deps = deps;
    }
    get opened() {
        return Boolean(this.win && !this.win.isDestroyed());
    }
    focus() {
        if (!this.opened)
            return;
        if (this.win.isMinimized())
            this.win.restore();
        this.win.focus();
    }
    toggle() {
        if (this.opened)
            this.close();
        else
            this.open();
    }
    open() {
        if (this.opened) {
            (0, logger_1.log)('backrooms.alreadyOpen');
            this.focus();
            return;
        }
        // ipcMain 是全局的，只注册一次；每次开窗复用同一个 handler（靠 sender 校验区分）
        if (!this.handler) {
            this.handler = (e, msg) => {
                const me = this.win;
                if (!me || me.isDestroyed())
                    return;
                // 只接受**这个窗口**发来的事件，别的窗口伪造不了
                if (e.sender !== me.webContents)
                    return;
                const raw = (msg ?? {});
                const kind = typeof raw.kind === 'string' ? raw.kind : '';
                if (!kind)
                    return;
                const data = raw.data && typeof raw.data === 'object' ? raw.data : {};
                this.deps.onEvent({ kind, data });
            };
            electron_1.ipcMain.on('game:event', this.handler);
        }
        const win = new electron_1.BrowserWindow({
            width: 900,
            height: 620,
            minWidth: 820,
            minHeight: 560,
            title: '后室漫游：回到现实',
            backgroundColor: '#0c0b09', // 和游戏 :root 的 --bg 一致，避免白闪
            autoHideMenuBar: true,
            show: false,
            webPreferences: {
                preload: this.deps.preload,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: false,
                webSecurity: true,
                spellcheck: false,
                // 游戏是纯 DOM，不需要 GPU 合成层；关掉能少一类"透明/显卡"问题
                backgroundThrottling: false
            }
        });
        this.win = win;
        win.once('ready-to-show', () => {
            win.show();
            (0, logger_1.log)('backrooms.opened', { width: win.getBounds().width, height: win.getBounds().height });
        });
        win.on('closed', () => {
            this.win = null;
            (0, logger_1.log)('backrooms.closed');
            this.deps.onClosed?.();
        });
        win.webContents.on('render-process-gone', (_e, d) => {
            (0, logger_1.log)('backrooms.rendererGone', { reason: d.reason, exitCode: d.exitCode });
        });
        win.webContents.on('console-message', (_e, level, message) => {
            if (level >= 2)
                (0, logger_1.log)('backrooms.console', { level, message: String(message).slice(0, 300) });
        });
        win.webContents.on('did-fail-load', (_e, code, desc) => {
            (0, logger_1.log)('backrooms.loadFailed', { code, desc, url: URL_PATH });
        });
        void win.loadURL(URL_PATH);
    }
    close() {
        if (!this.opened)
            return;
        this.win.close();
    }
    /**
     * 从游戏里读出结算数据。
     *
     * 为什么要 `executeJavaScript` 而不是读 localStorage：
     *   游戏暴露了 `window.__STORY__`（含 `get state`），拿到的就是我们需要的 `S`
     *   —— 已经算好的 gems/flags/aff，不用我们重新解析存档结构。
     *   而 localStorage 在游戏页面自己的 origin 下，主进程没有直接读法。
     */
    async readSummary() {
        if (!this.opened)
            return null;
        try {
            return (await this.win.webContents.executeJavaScript(`(() => {
        const S = (window.__STORY__ && window.__STORY__.state) || null
        if (!S) return null
        const gems = ['g1','g2','g3','g4','g5']
        const got = gems.filter(k => S.gems && S.gems[k] && S.gems[k].got)
        const dim = gems.filter(k => S.gems && S.gems[k] && S.gems[k].got && S.gems[k].dim)
        return {
          endKind: (S.flags && S.flags.endKind) || 'good',
          node: S.node || 1,
          gems: got.length,
          dimGems: dim.length,
          affinity: S.aff || '生疏',
          hurt: (S.flags && S.flags.hurt) || 0,
          rescued: Boolean(S.flags && (S.flags.rescue || S.flags.savedAI)),
          dreamLoops: (S.flags && S.flags.dreamLoops) || 0,
          elapsedMs: Math.max(0, Date.now() - (S.t || Date.now())),
          playerName: (S.player && S.player.name) || '',
          companionName: (S.ai && S.ai.name) || ''
        }
      })()`));
        }
        catch (e) {
            (0, logger_1.log)('backrooms.summaryFailed', { error: String(e).slice(0, 200) });
            return null;
        }
    }
    /** 清掉游戏存档并重新开始（结算页的「再玩一次」） */
    async replay() {
        if (!this.opened)
            return;
        try {
            await this.win.webContents.executeJavaScript(`(() => {
        try { localStorage.removeItem('backrooms_return_v1') } catch (e) {}
        location.reload()
        return true
      })()`);
            (0, logger_1.log)('backrooms.replay');
        }
        catch (e) {
            (0, logger_1.log)('backrooms.replayFailed', { error: String(e).slice(0, 200) });
        }
    }
    dispose() {
        this.close();
        if (this.handler) {
            electron_1.ipcMain.removeListener('game:event', this.handler);
            this.handler = null;
        }
    }
}
exports.BackroomsWindow = BackroomsWindow;
/** 窗口图标（打包版/resources 下也能找到；找不到就交给 Electron 默认） */
function backroomsIcon(root) {
    return (0, node_path_1.join)(root, 'assets', 'icon', 'tray.png');
}
