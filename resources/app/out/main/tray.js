"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupTray = setupTray;
const electron_1 = require("electron");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const config_1 = require("./config");
const logger_1 = require("./logger");
/**
 * 托盘 + 全局热键。
 * P0 关键点：热键驱动的是**真实可验证的状态位** screenPaused，并在气泡里给出反馈。
 * 黑名单只注册为纯函数 isBlocked()，不接截屏（P0 无截屏）。
 */
function setupTray(win, cfg, state, onChange, 
/**
 * 切换渲染路线（由 index.ts 注入 —— 它知道窗口基准高度、也负责调 switchRenderer）。
 * 不在这里直接 import window.ts，避免 tray ↔ window 循环依赖。
 */
switchRenderer, 
/** 打开《后室漫游》小游戏窗口（同样由 index.ts 注入，避免循环依赖） */
onPlayBackrooms, 
/** 打开设置窗（同上） */
onOpenSettings) {
    const iconPath = (0, config_1.assetPath)((0, node_path_1.join)('icon', 'tray.png'));
    let tray = null;
    if ((0, node_fs_1.existsSync)(iconPath)) {
        tray = new electron_1.Tray(electron_1.nativeImage.createFromPath(iconPath));
        tray.setToolTip('DSH 桌宠');
    }
    else {
        // 缺图标不能让整个应用崩掉（new Tray 会抛异常）
        (0, logger_1.log)('tray.icon_missing', { iconPath });
    }
    const togglePause = () => {
        state.screenPaused = !state.screenPaused;
        (0, logger_1.log)('state.screenPaused', { screenPaused: state.screenPaused });
        onChange(state);
        rebuild();
    };
    const toggleVisible = () => {
        state.visible = !state.visible;
        if (state.visible)
            win.show();
        else
            win.hide();
        onChange(state);
        rebuild();
    };
    /** 运行时切渲染路线（rig ⇄ frames），改完立即重载页面 —— 不用重启应用。 */
    const toggleRenderer = () => {
        const next = state.renderer === 'rig' ? 'frames' : 'rig';
        state.renderer = next;
        (0, logger_1.log)('state.renderer', { renderer: next });
        try {
            switchRenderer?.(next);
        }
        catch (e) {
            (0, logger_1.log)('state.renderer_failed', { error: String(e).slice(0, 200) });
        }
        onChange(state);
        rebuild();
    };
    /** 语音开关：翻状态位即可（TTS 那边每次说话前检查 state.ttsOn） */
    const toggleTts = () => {
        state.ttsOn = !state.ttsOn;
        (0, logger_1.log)('state.ttsOn', { ttsOn: state.ttsOn });
        onChange(state);
        rebuild();
    };
    const rebuild = () => {
        if (!tray)
            return;
        tray.setToolTip(`DSH 桌宠 · 截屏${state.screenPaused ? '已暂停' : '开启'}`);
        tray.setContextMenu(electron_1.Menu.buildFromTemplate([
            { label: `👁 截屏感知：${state.screenPaused ? '已暂停' : '开启'}`, click: togglePause },
            {
                label: `🎨 渲染路线：${state.renderer === 'rig' ? '实时 rig' : '帧（兼容）'}`,
                click: toggleRenderer
            },
            { label: `🔊 语音：${state.ttsOn ? '开' : '关'}`, click: toggleTts },
            { type: 'separator' },
            { label: '🎮 玩《后室漫游》', click: () => onPlayBackrooms?.() },
            { label: '⚙ 设置…', click: () => onOpenSettings?.() },
            { type: 'separator' },
            { label: state.visible ? '隐藏桌宠' : '显示桌宠', click: toggleVisible },
            { type: 'separator' },
            {
                label: '打开自检目录',
                click: () => {
                    void electron_1.shell.openPath((0, node_path_1.join)((0, config_1.projectRoot)(), '.selfcheck', 'shots'));
                }
            },
            { label: '打开日志目录', click: () => void electron_1.shell.openPath((0, node_path_1.join)((0, config_1.projectRoot)(), '.local')) },
            { type: 'separator' },
            { label: '退出', click: () => electron_1.app.exit(0) }
        ]));
    };
    rebuild();
    // 双击托盘图标 = 显示/隐藏，符合 Windows 上的普遍习惯
    if (tray) {
        tray.on('double-click', toggleVisible);
    }
    // 黑名单自检：把当前活动窗口标题过一遍（P0 仅验证函数可用）
    (0, logger_1.log)('blocklist.loaded', {
        size: cfg.privacy.blocklist.length,
        selfTest: {
            '1Password 8': (0, config_1.isBlocked)('1Password 8', cfg.privacy.blocklist),
            'Visual Studio Code': (0, config_1.isBlocked)('Visual Studio Code', cfg.privacy.blocklist)
        }
    });
    // ---- 全局热键（注册可能失败，必须回报）----
    const reg = (accel, label, fn) => {
        try {
            const ok = electron_1.globalShortcut.register(accel, fn);
            (0, logger_1.log)('hotkey.register', { accel, label, ok });
            return ok;
        }
        catch (e) {
            (0, logger_1.log)('hotkey.error', { accel, label, error: String(e) });
            return false;
        }
    };
    reg(cfg.hotkeys.toggleScreenPause, '切换截屏暂停', togglePause);
    reg(cfg.hotkeys.toggleVisible, '切换显示/隐藏', toggleVisible);
    // 任务管理器里这个进程叫 electron.exe，用户很难认出来 —— 所以必须有一个明确的退出方式
    reg(cfg.hotkeys.quit, '退出桌宠', () => {
        (0, logger_1.log)('app.quitByHotkey', { accel: cfg.hotkeys.quit });
        electron_1.app.exit(0);
    });
    return tray;
}
