"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const budget_1 = require("./budget");
const chat_1 = require("./chat");
const chatSession_1 = require("./chatSession");
const chatWindow_1 = require("./chatWindow");
const config_1 = require("./config");
const dragdebug_1 = require("./dragdebug");
const gameBridge_1 = require("./gameBridge");
const logger_1 = require("./logger");
const deepseek_1 = require("../providers/deepseek");
const rigProtocol_1 = require("./rigProtocol");
const index_1 = require("./tts/index");
const host_1 = require("../game/host");
const backrooms_1 = require("./backrooms");
const finishWindow_1 = require("./finishWindow");
const prompt_1 = require("./prompt");
const settingsIpc_1 = require("./settingsIpc");
const screen_1 = require("./screen");
const selfcheck_1 = require("./selfcheck");
const tray_1 = require("./tray");
const voiceBridge_1 = require("./voiceBridge");
const window_1 = require("./window");
const argv = process.argv.slice(1);
const SELFCHECK = argv.includes('--selfcheck');
const profileArg = argv.find((a) => a.startsWith('--profile='));
const PROFILE = (profileArg?.split('=')[1] ?? 'A').toUpperCase() || 'A';
// C：关闭硬件加速（须在 ready 之前）
//
// ⚠️ 注意：'rig' 渲染路线用的是 **WebGL**，关掉硬件加速后 rig 起不来。
//    所以 profile C 会被强制回退到 PNG 帧路线（就是这条老路线的用处）。
if (PROFILE === 'C')
    electron_1.app.disableHardwareAcceleration();
// B/C：开启透明视觉开关
if (PROFILE === 'B' || PROFILE === 'C')
    electron_1.app.commandLine.appendSwitch('enable-transparent-visuals');
// ★ 渲染路线：注册 `app://` 特权 scheme（必须在 ready 之前，见 rigProtocol.ts 注释）
(0, rigProtocol_1.registerRigScheme)();
// ⚠️ **单实例锁**：没有它会出现"两个桌宠、两个托盘图标"（2026-10-18 实测，
//    用户看到的是旧实例的旧菜单，以为新功能没生效），而且两个进程抢同一个 userdata。
//    放在 whenReady **之前**：拿不到锁就直接退出，让已有实例浮到前面。
const gotLock = electron_1.app.requestSingleInstanceLock();
if (!gotLock) {
    // 用 exit 而不是 quit：ready 之前 quit 会被忽略（实测第二次双击仍建了窗口）
    electron_1.app.exit(0);
}
else {
    electron_1.app.on('second-instance', () => {
        // 用户又双击了一次：把已有窗口叫到前面（这里没有全局 win 引用，靠托盘/窗口自己的 focus）
        for (const w of require('electron').BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed()) {
                if (w.isMinimized())
                    w.restore();
                w.focus();
            }
        }
    });
}
electron_1.app.whenReady().then(async () => {
    // ⚠️ 必须是 `let`：设置窗保存后要重读配置（`reloadConfig`）。
    //    用 `const` 的话模型一直用启动时那份旧 cfg —— 表现就是
    //    "填了人设、关掉设置窗、再打开又变回旧值"（2026-10-18 用户实测踩到）。
    let cfg = (0, config_1.loadConfig)();
    (0, rigProtocol_1.handleRigProtocol)((0, config_1.projectRoot)());
    // profile C 没有硬件加速 ⇒ rig 的 WebGL 起不来，强制走 PNG 帧
    if (PROFILE === 'C' && cfg.pet.renderer === 'rig') {
        cfg.pet.renderer = 'frames';
        (0, logger_1.log)('renderer.forced-frames', { reason: 'profile C 关闭了硬件加速，WebGL rig 不可用' });
    }
    // root 必须显式传：Budget 刻意不 import config（那会把 electron 拖进来，
    // 让它无法在命令行里验证），所以工作根目录由调用方注入。
    const budget = new budget_1.Budget({ ...cfg.budget, root: (0, config_1.projectRoot)() });
    // 先解析角色素材，拿到帧尺寸，才能把窗口收紧到刚好装下角色
    const pet = (0, config_1.resolvePetFrames)(cfg.pet.id);
    const win = (0, window_1.createPetWindow)(cfg, PROFILE, pet?.size);
    const state = {
        screenPaused: cfg.privacy.screenPaused,
        visible: true,
        renderer: cfg.pet.renderer,
        ttsOn: cfg.tts.enabled
    };
    /** 当前动画状态：人格注入用（【当前状态：x】），由 mood/拖拽等事件更新 */
    let currentPetState = 'idle';
    /** 打开设置窗（在 tts 之后才接线；用对象持有，避免 TS 把闭包里的 let 窄化成 never） */
    const settingsCtl = { open: null };
    /** 游戏窗口（在 story 之后才创建，IPC 需要提前引用） */
    let backroomsRef = null;
    /** TTS 管理器（在 PY 定义之后才创建，这里先占位） */
    let ttsRuntime = null;
    electron_1.ipcMain.handle('pet:ping', () => 'pong');
    electron_1.ipcMain.handle('game:open', () => { backroomsRef?.open(); return { ok: true }; });
    electron_1.ipcMain.handle('game:close', () => { backroomsRef?.close(); return { ok: true }; });
    electron_1.ipcMain.handle('game:opened', () => ({ opened: Boolean(backroomsRef?.opened) }));
    electron_1.ipcMain.handle('pet:config', () => ({
        profile: PROFILE,
        screenPaused: state.screenPaused,
        limitCNY: cfg.budget.monthlyLimitCNY,
        budget: budget.snapshot(),
        model: cfg.llm.model,
        hasApiKey: cfg.secrets.apiKey.length > 0,
        hotkeys: cfg.hotkeys,
        // 角色素材：null 表示用内置占位素材
        pet: { id: cfg.pet.id, frames: pet?.states ?? null, size: pet?.size ?? null, grab: pet?.grab ?? null },
        drag: cfg.drag
    }));
    electron_1.ipcMain.on('pet:rendererReady', () => {
        (0, logger_1.log)('renderer.ready', { profile: PROFILE });
    });
    // ---- 拖动 ----
    //
    // 这里踩过两次坑，都记下来：
    //
    // 1) 早期用渲染层的 e.screenX/screenY 算绝对坐标。screenY = 窗口Y + clientY，
    //    而拖动时窗口自己在动，Chromium 用的是过期 clientY，于是 screenY 跟着窗口
    //    一起涨 —— 正反馈，窗口加速下落直到冲出屏幕，最后 y 超 int32 抛
    //    "conversion failure from"。
    //
    // 2) 改用 screen.getCursorScreenPoint() 后仍然复现。探针（tools/probe-drag.js）
    //    测出显示器是 1.5x 缩放，而**光标读数与 setPosition 不保证同一坐标空间**：
    //    若光标是物理像素、setPosition 要 DIP，每帧就会多走 1.5 倍 → 同样越拖越偏、
    //    同样最后溢出。
    //
    // 所以不再假设单位：拖开始时用「渲染层报告的指针在窗口内的 DIP 位置」反推换算系数
    //   指针在窗口内位置 p  =  光标读数/系数 s  -  窗口位置 w
    //   =>  s = 光标读数 / (p + w)
    // 同空间时 s≈1；光标是物理像素时 s≈scaleFactor(1.5)。
    //
    // 但**不能直接用这个比值**：它由两个整数相除得来，噪声会让它落在 1.03 这种
    // 毫无意义的值上，于是每帧都偏一点、慢慢漂。所以只认两种可能：1 或者当前显示器的
    // scaleFactor，取更接近的那个。
    let dragStart = null;
    /** 本次拖动累计移动了几步，仅用于诊断编号 */
    let dragMoves = 0;
    // ---- 窗口尺寸漂移的修补 ----
    //
    // 实测（.selfcheck/drag/samples.jsonl）：只用 win.setPosition() 移动，
    // **窗口每次移动会长大约 1px**（宽增量非零 286/348 次、均值 0.82；
    // 和移动距离无关，移动 4px 也涨、39px 也涨）。
    // 一次拖动就从 240x262 涨到 526x514，跨会话累积到 1760x2146 —— 放大了 7.3 倍。
    // 用户看到的就是「一拖动背景就扩大」。
    //
    // 位置计算本身是对的（光标位移 / 窗口位移 = 1.000），canvas 也始终 224x224，
    // 所以问题出在 Electron/Windows 的 DIP 往返上（创建时我要 236x258，
    // 实际生效 240x262，已经差 4px）。既然治不了源头，就每次移动把尺寸按回去。
    const baseBounds = win.getBounds();
    const baseSize = { width: baseBounds.width, height: baseBounds.height };
    let sizeFixes = 0;
    /**
     * 气泡模式额外撑高的像素。
     *
     * 窗口创建时只预留了 `window.bubbleSpace`（22px）的气泡空间，
     * 多行回复根本放不下。所以显示气泡时把窗口**向上**长高 ——
     * 角色在窗口里是底对齐的，往上长不会让它移位。
     *
     * ⚠️ 这个值必须参与尺寸守护的比较，否则 sizeGuard 会在 2 秒内把它压回去。
     */
    let bubbleExtra = 0;
    /** 当前"正常"尺寸 = 基准尺寸 + 气泡额外高度 */
    function targetSize() {
        return { width: baseSize.width, height: baseSize.height + bubbleExtra };
    }
    /** 设置气泡额外高度（0 = 收起）。会同步调整 y 让角色保持原位。 */
    function setBubbleExtra(px) {
        if (!alive())
            return;
        const want = Math.max(0, Math.round(px));
        if (want === bubbleExtra)
            return;
        const b = win.getBounds();
        const delta = want - bubbleExtra;
        bubbleExtra = want;
        // 往上长：y 减小、height 增大，底边不动 → 角色视觉位置不变
        win.setBounds({ x: b.x, y: b.y - delta, width: baseSize.width, height: baseSize.height + want });
        (0, logger_1.log)('window.bubbleMode', { extra: want });
    }
    /** 移动窗口，并强制把尺寸还原到当前应有的大小。 */
    function moveKeepingSize(x, y) {
        const b = win.getBounds();
        const t = targetSize();
        if (b.width === t.width && b.height === t.height) {
            win.setPosition(x, y);
            return;
        }
        // 尺寸被系统改过：连位置带尺寸一次设回去
        win.setBounds({ x, y, width: t.width, height: t.height });
        if (++sizeFixes <= 3 || sizeFixes % 100 === 0) {
            (0, logger_1.log)('window.sizeDriftFixed', {
                from: { w: b.width, h: b.height },
                to: t,
                fixes: sizeFixes
            });
        }
    }
    /**
     * 定时守护：尺寸一旦被改回去。拖动路径已经处理了，
     * 这一层是兜底 —— 万一还有别的路径让窗口长大（比如系统消息、DPI 变化），
     * 也能在两秒内纠正，而不是等用户拖出个 1760x2146 的怪物。
     *
     * 注意比较的是 `targetSize()` 而不是 `baseSize` —— 否则气泡撑高会被它压回去。
     */
    const sizeGuard = setInterval(() => {
        if (!alive())
            return;
        const b = win.getBounds();
        const t = targetSize();
        if (b.width !== t.width || b.height !== t.height) {
            win.setBounds({ x: b.x, y: b.y, width: t.width, height: t.height });
            if (++sizeFixes <= 3 || sizeFixes % 100 === 0) {
                (0, logger_1.log)('window.sizeGuardFix', {
                    from: { w: b.width, h: b.height },
                    to: t,
                    fixes: sizeFixes
                });
            }
        }
    }, 2000);
    electron_1.app.on('before-quit', () => clearInterval(sizeGuard));
    /**
     * 窗口是否还能用。
     *
     * 自检跑完会 app.exit(0)、托盘退出也一样，窗口被销毁后排队中的 IPC 消息
     * 仍会执行，任何 win.* 调用都会抛 "Object has been destroyed"。
     * 所以每个处理器入口都要先问一句。
     */
    const alive = () => !win.isDestroyed() && !win.webContents.isDestroyed();
    // 拖动诊断：config.debug.dragCapture = true 时，每步数值写盘 + 拖动中截图。
    // 用来定位「拖动时画面到底变成了什么」这种看代码推不出来的问题。
    const diag = new dragdebug_1.DragDiag((0, config_1.projectRoot)(), cfg.debug.dragCapture);
    if (diag.on)
        (0, logger_1.log)('drag.diagOn', { dir: '.selfcheck/drag' });
    /** 渲染层报告的视口信息：精灵在窗口内实际画在哪、多大 */
    electron_1.ipcMain.on('pet:debug', (_e, msg) => {
        diag.viewport(msg);
    });
    electron_1.ipcMain.on('pet:dragStart', (_e, msg) => {
        if (!alive())
            return;
        const raw = electron_1.screen.getCursorScreenPoint();
        const [wx, wy] = win.getPosition();
        const p = msg?.pointer;
        // 校准：把比值吸附到 1 或显示器的 scaleFactor
        const sf = electron_1.screen.getDisplayNearestPoint(raw).scaleFactor || 1;
        const snap = (ratio) => (Math.abs(ratio - 1) <= Math.abs(ratio - sf) ? 1 : sf);
        const s = { x: 1, y: 1 };
        if (p && wx + p.x > 40 && wy + p.y > 40 && raw.x > 40 && raw.y > 40) {
            const sx = raw.x / (wx + p.x);
            const sy = raw.y / (wy + p.y);
            if (sx > 0.2 && sx < 5)
                s.x = snap(sx);
            if (sy > 0.2 && sy < 5)
                s.y = snap(sy);
        }
        (0, logger_1.log)('drag.calibrate', { raw, win: { x: wx, y: wy }, pointer: p ?? null, scaleFactor: sf, s });
        // 两种锚定方式：
        //   anchor=cursor —— 保持按下时指针在窗口内的相对位置，窗口不跳（默认）
        //   anchor=grab   —— 让光标正对「抓取锚点」（画在 held 素材里的那只手捏住呆毛的点）
        const useGrab = cfg.drag.anchor === 'grab' &&
            msg?.anchor &&
            Number.isFinite(msg.anchor.x) &&
            Number.isFinite(msg.anchor.y);
        const offset = useGrab
            ? { x: msg.anchor.x, y: msg.anchor.y }
            : p && Number.isFinite(p.x) && Number.isFinite(p.y)
                ? { x: p.x, y: p.y }
                : { x: raw.x / s.x - wx, y: raw.y / s.y - wy };
        dragStart = { s, offset, origin: raw, moved: false };
        diag.start(win, raw, s, offset, p ?? null);
        // 这里不动窗口：单纯点一下不该让桌宠跳走。吸附发生在第一次真正移动时。
    });
    electron_1.ipcMain.on('pet:dragMove', () => {
        if (!dragStart || !alive())
            return;
        const raw = electron_1.screen.getCursorScreenPoint();
        // 先判「算不算真的在拖」。没超过阈值就直接返回 —— 否则手抖产生的一两个
        // pointermove 也会被当成拖动，窗口会突兀地跳一下。
        if (!dragStart.moved) {
            const d = Math.abs(raw.x - dragStart.origin.x) + Math.abs(raw.y - dragStart.origin.y);
            if (d <= 4)
                return;
            dragStart.moved = true;
            win.webContents.send('pet:dragMoved');
        }
        // 先把光标读数换成 DIP，再算窗口位置
        const cx = raw.x / dragStart.s.x;
        const cy = raw.y / dragStart.s.y;
        const tx = Math.round(cx - dragStart.offset.x);
        const ty = Math.round(cy - dragStart.offset.y);
        // setPosition 只接受 int32。NaN / Infinity / 越界一律拦掉 ——
        // 之前就是漏了这里，直接抛 "conversion failure from"。
        if (!Number.isFinite(tx) || !Number.isFinite(ty))
            return;
        if (tx < -30000 || tx > 30000 || ty < -30000 || ty > 30000)
            return;
        moveKeepingSize(tx | 0, ty | 0);
        diag.move(win, ++dragMoves, raw, { x: cx, y: cy }, { x: tx, y: ty });
        diag.screenshot(win, 25);
    });
    /** 返回是否真的移动过，渲染层据此区分「点击」与「拖动」 */
    electron_1.ipcMain.handle('pet:dragEnd', () => {
        const moved = dragStart?.moved ?? false;
        if (alive())
            diag.end(win, moved);
        dragStart = null;
        dragMoves = 0;
        return { moved };
    });
    electron_1.ipcMain.on('pet:quit', () => {
        (0, logger_1.log)('app.quitByRenderer');
        electron_1.app.exit(0);
    });
    // ---- 聊天窗（Day 1 步 3）----
    // 单独的普通窗口，不置顶、可缩放，摆在桌宠窗旁边。
    // 双击桌宠 / 右键菜单 / 热键 都能打开；已开着就聚焦而不是再开一个。
    //
    // ⚠️ 聊天记录归**主进程**（ChatLog），不放渲染层 DOM。
    //    原因：窗口关掉后销毁，下次打开是全新渲染层，DOM 里的消息全没了
    //    —— 这是用户实测发现的 bug。而且步 5 起主进程要往两个窗口广播 chunk，
    //    它本来就必须持有会话上下文。
    //    刻意**不**用 preventDefault 拦关闭来保活窗口：本项目退出走
    //    `app.exit(0)`（三条路径），而它不触发 before-quit，拦错了就退不出程序。
    const chatLog = new chat_1.ChatLog({ root: (0, config_1.projectRoot)() });
    let chatWin = null;
    const openChat = () => {
        if (!alive())
            return;
        const r = (0, chatWindow_1.ensureChatWindow)(chatWin, { preload: (0, node_path_1.join)(__dirname, '../preload/index.js') }, win.getBounds());
        chatWin = r.win;
        if (r.created) {
            // 窗口真的销毁时才置空。注意这里没拦 close，所以不阻止退出。
            chatWin.once('closed', () => { chatWin = null; });
        }
        // 历史由渲染层加载时主动 invoke('chat:history') 拉取。
        // 刻意**不**在这里 webContents.send 推 —— push 和 pull 如果都在，
        // 历史会被渲染两遍。保持单向：渲染层拉，主进程给。
        (0, logger_1.log)('chat.window', { created: r.created, history: chatLog.length });
    };
    electron_1.ipcMain.on('pet:openChat', openChat);
    // 渲染层每加一条就报给主进程落盘
    electron_1.ipcMain.on('chat:append', (_e, e) => {
        if (!e || typeof e.text !== 'string' || !e.text)
            return;
        const allowed = ['user', 'pet', 'sys', 'error'];
        const who = allowed.includes(e.who) ? e.who : 'sys';
        const entry = { who, text: e.text };
        if (typeof e.meta === 'string' && e.meta)
            entry.meta = e.meta;
        chatLog.append(entry);
    });
    // 渲染层加载时主动拉一次历史（和上面的 push 互为兜底）
    electron_1.ipcMain.handle('chat:history', () => chatLog.all());
    // ---- 会话（Day 1 步 5-6）----
    // 同一份流式文本要同时喂给**桌宠窗的气泡**和**聊天窗的消息区**，
    // 所以广播走一个统一的 helper，别在两处各写一遍。
    const provider = (0, deepseek_1.createProvider)({
        baseUrl: cfg.llm.baseUrl,
        model: cfg.llm.model,
        // 传函数而不是值：设置窗里填完 Key 后**下一轮就生效**，不用重启
        apiKey: () => cfg.secrets.apiKey,
        thinking: cfg.llm.thinking,
        temperature: cfg.llm.temperature,
        maxTokens: cfg.llm.maxTokens
    });
    const broadcast = (channel, payload) => {
        if (alive())
            win.webContents.send(channel, payload);
        if (chatWin && !chatWin.isDestroyed() && !chatWin.webContents.isDestroyed()) {
            chatWin.webContents.send(channel, payload);
        }
    };
    /** 气泡显示时给窗口加多少高度。够放 3-4 行中文。 */
    const BUBBLE_H = 104;
    let bubbleTimer = null;
    const session = new chatSession_1.ChatSession({
        provider,
        log: chatLog,
        budget,
        // 人格来自配置，不再硬编码 —— 换性格只要改 config/default.json
        // 每轮现算：人格可能刚在设置窗改过；状态也要跟着动画走（【当前状态：held】）
        systemPrompt: () => (0, prompt_1.buildSystemPrompt)({
            personality: cfg.chat.personality,
            name: cfg.identity.name,
            userName: cfg.identity.userName,
            stateInjection: cfg.personality.stateInjection,
            state: currentPetState
        }),
        historyLimit: cfg.chat.historyLimit,
        typewriterCps: cfg.chat.typewriterCps,
        minThinkingMs: cfg.chat.minThinkingMs,
        onDelta: (delta) => broadcast('chat:delta', { delta }),
        onFirstToken: (ms) => broadcast('chat:firstToken', { ms }),
        onState: (mood) => {
            currentPetState = (typeof mood === 'string' ? mood : 'idle');
            if (alive())
                win.webContents.send('pet:mood', mood);
            broadcast('chat:mood', mood);
        },
        onDone: (info) => {
            broadcast('chat:done', info);
            // 气泡留一会儿再收起，让用户看完
            if (bubbleTimer)
                clearTimeout(bubbleTimer);
            bubbleTimer = setTimeout(() => setBubbleExtra(0), 8000);
            // 念出来（预算熔断/报错不念 —— 用户明确要求）
            if (!info.blocked && info.text)
                void speakOut(info.text);
        },
        onError: (message) => broadcast('chat:error', { message }),
        // 屏幕感知那一轮按次切到多模态模型；没配置就不许"看"
        visionModel: cfg.vision.enabled ? cfg.vision.model : undefined
    });
    // ---- 屏幕感知：看一眼屏幕（按需单次，绝不是常驻）----
    // 三道闸门，全在**抓屏之前**：
    //   ① vision.enabled（配置）② state.screenPaused（托盘/热键）③ 前台窗口命中黑名单
    electron_1.ipcMain.handle('screen:look', async (_e, question) => {
        if (!cfg.vision.enabled) {
            return { ok: false, error: '屏幕感知没开（config.vision.enabled）' };
        }
        if (state.screenPaused) {
            return { ok: false, error: '截屏感知已暂停（托盘里可以打开，或按 Ctrl+Alt+P）' };
        }
        // 隐私闸门（**抓屏之前**）：
        //   优先用前台窗口标题（精确）；拿不到就退化成"把所有可见窗口标题查一遍"（宁可错拒，也不看）。
        const fgTitle = await (0, screen_1.foregroundTitle)(PY);
        let gateTitles = fgTitle ? [fgTitle] : await (0, screen_1.visibleWindowTitles)();
        let gateMode = fgTitle ? 'foreground' : 'windowList';
        if (!fgTitle && gateTitles.length === 0) {
            // 连窗口列表都拿不到：判不了 ⇒ 保守起来**不看**（并且告诉用户原因）
            (0, logger_1.log)('screen.gateUnknown', { reason: 'no foreground title and no window list' });
            return { ok: false, error: '读不到当前窗口信息，为了安全这次不看' };
        }
        const hitTitle = gateTitles.find((t) => (0, config_1.isBlocked)(t, cfg.privacy.blocklist));
        if (hitTitle) {
            (0, logger_1.log)('screen.blocked', { mode: gateMode, title: hitTitle, checked: gateTitles.length });
            return {
                ok: false,
                blocked: true,
                title: hitTitle,
                error: `当前窗口里有敏感内容（${hitTitle.slice(0, 40)}），我不看`
            };
        }
        const shot = await (0, screen_1.capturePrimary)(cfg.vision.maxWidth);
        if (!shot) {
            (0, logger_1.log)('screen.lookFailed', { mode: gateMode, title: fgTitle });
            return { ok: false, error: '抓屏失败（可能被系统权限挡住）' };
        }
        (0, logger_1.log)('screen.look', {
            mode: gateMode,
            title: fgTitle || null,
            checked: gateTitles.length,
            bytes: shot.bytes,
            size: shot.size,
            displayId: shot.displayId ?? null
        });
        setBubbleExtra(BUBBLE_H);
        if (bubbleTimer) {
            clearTimeout(bubbleTimer);
            bubbleTimer = null;
        }
        const q = (question ?? '').trim() || '看看我的屏幕，用一两句话告诉我我现在在做什么。';
        void session.send(q, { image: shot.dataUrl });
        return { ok: true, title: fgTitle || null, mode: gateMode, bytes: shot.bytes, size: shot.size };
    });
    electron_1.ipcMain.on('chat:send', (_e, text) => {
        if (typeof text !== 'string')
            return;
        // 一发请求就把气泡撑开，思考中也要让用户看到"她在想"
        setBubbleExtra(BUBBLE_H);
        if (bubbleTimer) {
            clearTimeout(bubbleTimer);
            bubbleTimer = null;
        }
        void session.send(text);
    });
    electron_1.ipcMain.on('chat:cancel', () => session.cancel());
    // ---- 游戏桥（轨道 B · B-4，**只读**）----
    //
    // 起一个子进程跑 game/probe.js --json，把状态流显示在桌宠窗底部。
    // ⚠️ 桥不下发任何游戏动作 —— 让它动（P-2 之后）必须走 security-guardrails
    //    的确认流程。这里只做"看得见"。
    //
    // 默认关闭（config.game.enabled）：它会起子进程连服务器，
    // 不该在用户没准备好时自己跑起来。
    const game = cfg.game.enabled
        ? new gameBridge_1.GameBridge({
            opts: {
                root: (0, config_1.projectRoot)(),
                host: cfg.game.host,
                port: cfg.game.port,
                username: cfg.game.username,
                version: cfg.game.version,
                everyMs: cfg.game.everyMs
            },
            onState: (s) => {
                if (alive())
                    win.webContents.send('game:state', s);
            },
            onEvent: (kind, data) => {
                if (alive())
                    win.webContents.send('game:event', { kind, ...data });
            }
        })
        : null;
    if (game) {
        game.start();
        (0, logger_1.log)('game.enabled', {
            host: cfg.game.host,
            port: cfg.game.port,
            user: cfg.game.username,
            version: cfg.game.version,
            everyMs: cfg.game.everyMs,
            hud: cfg.game.hud
        });
    }
    else {
        (0, logger_1.log)('game.disabled', {});
    }
    /** 渲染层加载时可主动拉一次最新状态（避免等下一个采样周期） */
    electron_1.ipcMain.handle('game:state', () => (game ? game.latest : null));
    electron_1.app.on('before-quit', () => {
        game?.stop();
    });
    // ---- 语音输入（步 7）----
    //
    // 按住热键说话，松开识别，文字填进聊天输入框。
    // ⚠️ 只做**输入**：录 + 识别 + 交文字。不发任何系统/游戏动作。
    const PY = process.env.DSH_PYTHON ||
        (0, node_path_1.join)(process.env.USERPROFILE || '', '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe');
    /** 同一个状态要同时告诉桌宠窗和聊天窗 */
    const voiceStatus = (s) => {
        if (alive())
            win.webContents.send('voice:status', s);
        if (chatWin && !chatWin.isDestroyed() && !chatWin.webContents.isDestroyed()) {
            chatWin.webContents.send('voice:status', s);
        }
    };
    const voiceText = (text, info) => {
        if (!chatWin || chatWin.isDestroyed() || chatWin.webContents.isDestroyed()) {
            // 聊天窗没开就自动开一个 —— 否则识别结果没处放，用户会以为坏了
            openChat();
            setTimeout(() => {
                if (chatWin && !chatWin.isDestroyed())
                    chatWin.webContents.send('voice:text', { text, ...info });
            }, 500);
            return;
        }
        chatWin.webContents.send('voice:text', { text, ...info });
    };
    const voice = cfg.voice.enabled
        ? new voiceBridge_1.VoiceBridge({
            opts: {
                root: (0, config_1.projectRoot)(),
                python: PY,
                model: cfg.voice.model,
                language: cfg.voice.language,
                device: cfg.voice.device,
                computeType: cfg.voice.computeType,
                minMs: cfg.voice.minMs,
                maxMs: cfg.voice.maxMs,
                silenceMs: cfg.voice.silenceMs,
                pushToTalk: cfg.voice.pushToTalk,
                pttKey: cfg.voice.pttKey
            },
            onStatus: (s) => voiceStatus(s),
            onText: voiceText,
            onError: (message) => voiceStatus({ kind: 'error', message })
        })
        : null;
    if (voice) {
        voice.start();
        (0, logger_1.log)('voice.enabled', { model: cfg.voice.model, device: cfg.voice.device, language: cfg.voice.language });
    }
    else {
        (0, logger_1.log)('voice.disabled', {});
    }
    // 语音热键。
    //
    // ⚠️ 只做 `beginCapture()`，**不做 toggle**。
    //
    // 为什么（实测踩过的坑）：
    //   Electron 的 globalShortcut **只有按下事件，没有松开**；
    //   而 Windows 按住键会**重复发 keydown**。所以 toggle 式会失控 ——
    //   日志里能看到 begin/end 成对出现、间隔只有 30~150 毫秒，疯狂切换。
    //
    //   现在：**长按模式**下由 Python 自己轮询按键（能拿到松开事件），
    //   Electron 这边只负责**吞掉这个键** —— 不吞的话你按波浪键
    //   会往当前窗口里打出一个反引号。
    //
    // ⚠️⚠️ 但「吞键」有个反噬：**如果 Python 挂了，键被吞掉、录音又没起来，
    //    用户看到的是"按了完全没反应"** —— 分不清是热键没生效还是子进程死了。
    //    所以热键必须**跟着语音的就绪状态动态开关**：
    //      语音 ready  → 注册（吞键 + 长按可用）
    //      语音挂了    → 注销（把波浪键还给系统，反引号能正常打出来）
    //    onReadyChange 就是干这个的。
    if (voice && cfg.hotkeys.voice) {
        // 函数声明会被提升，所以可以先构造 bridge、后定义它们
        const accel = cfg.hotkeys.voice;
        const onReady = (r) => {
            try {
                if (r) {
                    if (electron_1.globalShortcut.isRegistered(accel))
                        return;
                    const ok = electron_1.globalShortcut.register(accel, () => {
                        if (cfg.voice.pushToTalk) {
                            // 长按模式：起停由 Python 的 GetAsyncKeyState 轮询负责，这里什么都不做
                            return;
                        }
                        if (voice.isRecording) {
                            (0, logger_1.log)('voice.hotkeyIgnored', { reason: 'already-recording' });
                            return;
                        }
                        voice.beginCapture();
                    });
                    (0, logger_1.log)('hotkey.register', {
                        accel,
                        label: cfg.voice.pushToTalk ? '语音输入（长按说话，键已被吞掉）' : '语音输入（按一下，自动停）',
                        ok
                    });
                }
                else {
                    if (electron_1.globalShortcut.isRegistered(accel)) {
                        electron_1.globalShortcut.unregister(accel);
                        (0, logger_1.log)('hotkey.unregister', { accel, reason: '语音未就绪，把键还给系统' });
                    }
                }
            }
            catch (e) {
                (0, logger_1.log)('hotkey.error', { accel, error: String(e) });
            }
        };
        // 立刻按当前状态同步一次（语音还没 ready 就先不注册）
        onReady(voice.isReady);
        voice.onReadyChange = onReady;
    }
    electron_1.ipcMain.on('voice:toggle', () => {
        if (!voice)
            return;
        if (!voice.isRecording)
            voice.beginCapture();
    });
    electron_1.ipcMain.on('voice:begin', () => {
        if (voice && !voice.isRecording)
            voice.beginCapture();
    });
    electron_1.ipcMain.on('voice:end', () => voice?.endCapture());
    electron_1.ipcMain.handle('voice:state', () => ({
        enabled: !!voice,
        ready: voice ? voice.isReady : false,
        recording: voice ? voice.isRecording : false
    }));
    electron_1.app.on('before-quit', () => {
        voice?.stop();
    });
    // 打开聊天窗的全局热键。
    // 暂未进 config（hotkeys 的类型里还没有这一项），先用固定值；
    // 等 Day 1 收尾时和语音热键一起挪进 config/default.json。
    // Ctrl+Alt+Space 预留给语音，所以这里用 C。
    const CHAT_ACCEL = 'Ctrl+Alt+C';
    try {
        const ok = electron_1.globalShortcut.register(CHAT_ACCEL, () => {
            if (alive())
                openChat();
        });
        (0, logger_1.log)('hotkey.register', { accel: CHAT_ACCEL, label: '打开聊天窗', ok });
    }
    catch (e) {
        (0, logger_1.log)('hotkey.error', { accel: CHAT_ACCEL, label: '打开聊天窗', error: String(e) });
    }
    // 右键菜单：给桌宠一个显而易见、不用去翻任务管理器的退出入口
    electron_1.ipcMain.on('pet:showMenu', () => {
        if (!alive())
            return;
        const menu = electron_1.Menu.buildFromTemplate([
            { label: '💬 打开聊天窗口', click: () => { if (!alive())
                    return; openChat(); } },
            { type: 'separator' },
            // 这两个是入口，和托盘保持一致 —— 用户最常点的是桌宠本体，
            // 右键菜单里没有的话会以为功能没做（真实发生过）。
            { label: '🎮 玩《后室漫游》', click: () => backroomsRef?.open() },
            { label: '⚙ 设置…', click: () => settingsCtl.open?.() },
            { type: 'separator' },
            { label: `👁 截屏感知：${state.screenPaused ? '已暂停' : '开启'}`, click: () => { if (!alive())
                    return; state.screenPaused = !state.screenPaused; win.webContents.send('pet:state', { screenPaused: state.screenPaused, visible: state.visible }); (0, logger_1.log)('state.screenPaused', { screenPaused: state.screenPaused }); } },
            { label: state.visible ? '隐藏桌宠' : '显示桌宠', click: () => { if (!alive())
                    return; state.visible = !state.visible; if (state.visible)
                    win.show();
                else
                    win.hide(); } },
            { type: 'separator' },
            { label: `退出桌宠  (${cfg.hotkeys.quit.replace('CommandOrControl', 'Ctrl')})`, click: () => { (0, logger_1.log)('app.quitByMenu'); electron_1.app.exit(0); } }
        ]);
        menu.popup({ window: win });
    });
    (0, tray_1.setupTray)(win, cfg, state, (s) => {
        if (!alive())
            return;
        win.webContents.send('pet:state', { screenPaused: s.screenPaused, visible: s.visible });
    }, (kind) => {
        // 托盘里切渲染路线：**只重载页面，不重启应用**。
        // baseSize.height 是气泡展开前的基准高度（rig 页要靠它锁角色缩放）。
        if (!alive())
            return;
        (0, window_1.switchRenderer)(win, cfg, kind, baseSize.height);
    }, () => {
        // 托盘「🎮 玩《后室漫游》」：窗口懒创建，没点就不占内存。
        // （回调是用户点击时才执行，那时 backroomsRef 早已赋值。）
        backroomsRef?.open();
    }, () => {
        // 托盘「⚙ 设置…」
        settingsCtl.open?.();
    });
    // ---- 互动叙事小游戏（`src/game/` 的接口层）----
    //
    // 这里只做"接线"：剧本逻辑全在 `src/game/stories/*`，宿主在 `src/game/host.ts`（不依赖 electron）。
    // 桌宠怎么动由下面这个 PetDriver 决定 —— 想改表现只改这里，不用碰剧本。
    const gameTypeTimer = { id: null };
    const stopGameTyping = () => {
        if (gameTypeTimer.id) {
            clearInterval(gameTypeTimer.id);
            gameTypeTimer.id = null;
        }
    };
    /** 逐字说话：复用 chat:delta / chat:done 通道，两条渲染路线（rig / 帧）都能显示 */
    const gameSay = (text) => {
        stopGameTyping();
        setBubbleExtra(BUBBLE_H);
        if (bubbleTimer) {
            clearTimeout(bubbleTimer);
            bubbleTimer = null;
        }
        if (!alive())
            return;
        // 先让页面**换一张新气泡**：气泡是复用的，不加这个信号，第二拍会追加在上一拍后面
        // （探针实测：两拍的文本连成了一大段）。
        win.webContents.send('pet:extra', { kind: 'bubble-reset' });
        // 气泡只有 104px 高（约 5 行、40~45 字）。剧情的一拍常常 100+ 字，
        // 直接塞进去会被裁掉半句 —— 所以气泡只放**摘要**，全文在聊天窗的剧情面板里。
        // 这一条是我实测截图才发现的：文本会被裁在气泡外、压在角色身上。
        const BUBBLE_MAX = 44;
        const full = String(text ?? '');
        const shown = full.length > BUBBLE_MAX ? full.slice(0, BUBBLE_MAX) + '…' : full;
        const chars = Array.from(shown);
        let i = 0;
        // 4 字一拍 → 长文本也能在可接受时间内说完；短句就一两拍
        gameTypeTimer.id = setInterval(() => {
            if (!alive()) {
                stopGameTyping();
                return;
            }
            const chunk = chars.slice(i, i + 4).join('');
            i += 4;
            broadcast('chat:delta', { delta: chunk });
            if (i >= chars.length) {
                stopGameTyping();
                broadcast('chat:done', { text, totalMs: 0 });
                if (bubbleTimer)
                    clearTimeout(bubbleTimer);
                bubbleTimer = setTimeout(() => setBubbleExtra(0), 9000);
            }
        }, 60);
    };
    const gamePet = {
        say: (text) => gameSay(text),
        mood: (m) => {
            currentPetState = (typeof m === 'string' ? m : 'idle');
            if (alive())
                win.webContents.send('pet:mood', m);
            broadcast('chat:mood', m);
        },
        expr: (name, secs) => {
            // rig 页统一走 `pet:extra`（帧路线没有动态表情，忽略即可）
            if (alive())
                win.webContents.send('pet:extra', { kind: 'expr', name, secs });
        },
        listening: (on) => { if (alive())
            win.webContents.send('pet:extra', { kind: 'listening', on }); },
        thinking: (on) => { if (alive())
            win.webContents.send('pet:extra', { kind: 'thinking', on }); }
    };
    const story = new host_1.StoryHost({
        root: (0, config_1.projectRoot)(),
        pet: gamePet,
        onChange: (v) => {
            broadcast('game:view', v);
            // 有剧情在跑时把聊天窗叫出来，否则用户不知道有东西等他点
            if (v.active && (!chatWin || chatWin.isDestroyed()))
                openChat();
        }
    });
    // ---- 互动小说《后室漫游：回到现实》----
    //
    // 游戏本体不改（单文件 HTML，自带 4 屏/存档/三结局），我们只提供窗口 + 事件通道，
    // 让桌宠对游戏里发生的事**做反应**（换表情/说一句话）。
    // 事件出口在游戏里：`emit()`，7 处调用，见 docs/game-hooks.md。
    let lastNodeReaction = 0;
    const backrooms = new backrooms_1.BackroomsWindow({
        root: (0, config_1.projectRoot)(),
        preload: (0, node_path_1.join)(__dirname, '..', '..', 'renderer', 'game-preload.js'),
        onClosed: () => broadcast('game:closed', true),
        onEvent: (ev) => {
            (0, logger_1.log)('game.event', { kind: ev.kind, data: ev.data });
            broadcast('backrooms:event', ev);
            const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
            switch (ev.kind) {
                case 'node': {
                    // 章节切换（`jump`/`auto` 会连着触发几次，做个节流）
                    const now = Date.now();
                    if (now - lastNodeReaction < 3000)
                        return;
                    lastNodeReaction = now;
                    gamePet.expr?.('thinking', 1500);
                    gamePet.say(pick(['又是新的地方。', '这里……不太对。', '跟上。']));
                    return;
                }
                case 'item':
                    gamePet.expr?.('happy', 1200);
                    return;
                case 'gem':
                    gamePet.expr?.('love', 2500);
                    gamePet.say(pick(['这个……收好。', '别弄丢了。', '有用。']));
                    return;
                case 'gem-dim':
                    gamePet.expr?.('surprised', 1800);
                    gamePet.say('它暗了。');
                    return;
                case 'check': {
                    const kind = String(ev.data.kind ?? '');
                    if (kind === 'crit-ok') {
                        gamePet.expr?.('happy', 2000);
                        gamePet.say(pick(['漂亮！', '过了。', '运气不错。']));
                    }
                    else if (kind === 'crit-fail') {
                        gamePet.expr?.('dizzy', 2000);
                        gamePet.say(pick(['……别硬撑。', '这下麻烦了。']));
                    }
                    else if (kind === 'fail') {
                        gamePet.expr?.('dizzy', 1200);
                    }
                    return;
                }
                case 'hurt':
                    gamePet.expr?.('dizzy', 1500);
                    return;
                case 'ending': {
                    const kind = String(ev.data.kind ?? '');
                    gamePet.mood?.('talking');
                    if (kind === 'good') {
                        gamePet.expr?.('happy');
                        gamePet.say('出来了。……挺好。');
                    }
                    else if (kind === 'warm') {
                        gamePet.expr?.('shy');
                        gamePet.say('……嗯。走吧。');
                    }
                    else {
                        gamePet.expr?.('neutral');
                        gamePet.say('至少你回来了。');
                    }
                    // 结算页：**等 0.8 秒**再弹，别抢游戏自己的结局动画。
                    // 数据从游戏状态里读（`__STORY__.state`），不猜存档结构。
                    setTimeout(() => {
                        void (async () => {
                            const raw = (await backrooms.readSummary()) ?? {};
                            (0, finishWindow_1.openFinishWindow)({
                                endKind: raw.endKind || 'good',
                                node: Number(raw.node ?? 1),
                                gems: Number(raw.gems ?? 0),
                                dimGems: Number(raw.dimGems ?? 0),
                                affinity: String(raw.affinity ?? '生疏'),
                                hurt: Number(raw.hurt ?? 0),
                                rescued: Boolean(raw.rescued),
                                dreamLoops: Number(raw.dreamLoops ?? 0),
                                elapsedMs: Number(raw.elapsedMs ?? 0),
                                playerName: String(raw.playerName ?? ''),
                                companionName: String(raw.companionName ?? '')
                            }, {
                                root: (0, config_1.projectRoot)(),
                                preload: (0, node_path_1.join)(__dirname, '../preload/index.js'),
                                // 再玩一次：清档 + 重开游戏（游戏窗保持打开）
                                onReplay: () => {
                                    void backrooms.replay();
                                },
                                // 回到桌面：关掉游戏窗，桌宠说一句收尾（走 TTS）
                                onBackToDesktop: () => {
                                    backrooms.close();
                                    const line = '回来了就好。';
                                    gamePet.say(line);
                                    void speakOut(line);
                                }
                            });
                        })();
                    }, 800);
                    return;
                }
                default:
                    return;
            }
        }
    });
    backroomsRef = backrooms;
    // ---- 语音合成（TTS）----
    //
    // 上层只调 `speakOut(text)`；引擎选择/回退/缓存/润色都在 TtsManager 里。
    // 播放由渲染层的 `<audio>` 做（这样能拿到 onended 去驱动口型），
    // 主进程只负责"把 data URL 发过去"，并记录 id 以忽略过期事件。
    ttsRuntime = new index_1.TtsManager(cfg.tts, {
        root: (0, config_1.projectRoot)(),
        python: PY,
        log: (ev, data) => (0, logger_1.log)(ev, data)
    });
    // ---- 语音冷启动预热 + 常用短句预置（路演关键）----
    //
    // 实测（2026-10-18）：本地克隆模型**第一次推理要 8~9 秒**，之后每句 3~5 秒。
    // 现场第一句话等 10 秒观感极差。这里在**启动后立刻后台跑**：
    //   ① warmup：合成一句不会被用到的话，把冷启动吃掉；
    //   ② preseed：把高频台词提前合成进缓存，说的时候 0 ms。
    // 注意：`void` 掉不 await —— 不能阻塞窗口创建；失败也只记日志。
    if (ttsRuntime.enabled) {
        void (async () => {
            try {
                const w = await ttsRuntime.warmup();
                (0, logger_1.log)('tts.warmupDone', w);
                const n = await ttsRuntime.preseed(['嗯。', '好呀。', '在呢。', '这个……收好。']);
                (0, logger_1.log)('tts.preseedDone', { count: n });
            }
            catch (e) {
                (0, logger_1.log)('tts.warmupFailed', { error: String(e).slice(0, 160) });
            }
        })();
    }
    /**
     * 只取"要念的第一句"。
     *
     * 为路演做的取舍（2026-10-18）：克隆模型每句 3~5 秒，整段 40 多字要 5 秒+。
     * 人判断"她有没有反应"靠的是**第一个声音**，所以先把第一句念出来，
     * 气泡里仍然显示完整回复。实测：整段 3.7 s → 单句 1.5~2 s。
     */
    const firstSentenceForSpeech = (text) => {
        const t = (text ?? '').trim();
        if (!t)
            return '';
        // 句末标点（中英文都算），保留标点本身让语气自然
        const m = /^[\s\S]*?[。！？!?…]/.exec(t);
        let s = m ? m[0] : t;
        // 太长的单句在逗号处再切一刀（避免一句念 6 秒）
        if (s.length > 24) {
            const comma = s.search(/[，,；;]/);
            if (comma > 6)
                s = s.slice(0, comma + 1);
            else
                s = s.slice(0, 24) + '。';
        }
        return s;
    };
    /** 让她说一句话（合成 → 发给渲染层播放）。失败只记日志，绝不打断文字流程。 */
    const speakOut = async (text) => {
        try {
            if (!ttsRuntime || !ttsRuntime.enabled || !state.ttsOn)
                return;
            const spoken = firstSentenceForSpeech(text);
            if (!spoken)
                return;
            // ---- 立刻"应一声"（路演关键）----
            // 克隆模型要 3~5 秒才吐音频，但人判断"她有没有反应"只看**第一个声音**。
            // 这里先播一句**已在缓存里**的"嗯。"（0 ms），真句子合成完再接上。
            // 只对慢引擎做；edge 本身 1.3 秒，不需要。
            if (ttsRuntime.engine === 'gpt-sovits') {
                const filler = await ttsRuntime.synth('嗯。');
                if (filler.ok && filler.audio && filler.mime && filler.id !== undefined && alive()) {
                    win.webContents.send('audio:play', {
                        id: filler.id,
                        dataUrl: `data:${filler.mime};base64,${filler.audio.toString('base64')}`,
                        text: '嗯。',
                        engine: filler.engine,
                        cacheHit: Boolean(filler.cacheHit)
                    });
                    (0, logger_1.log)('tts.filler', { ms: filler.ms, cacheHit: Boolean(filler.cacheHit) });
                }
            }
            const r = await ttsRuntime.synth(spoken);
            if (!r.ok || !r.audio || !r.mime || r.id === undefined) {
                (0, logger_1.log)('tts.skipped', { reason: r.error ?? 'no audio' });
                return;
            }
            if (!alive())
                return;
            win.webContents.send('audio:play', {
                id: r.id,
                dataUrl: `data:${r.mime};base64,${r.audio.toString('base64')}`,
                text: r.text,
                engine: r.engine,
                cacheHit: Boolean(r.cacheHit)
            });
        }
        catch (e) {
            (0, logger_1.log)('tts.error', { error: String(e).slice(0, 200) });
        }
    };
    electron_1.ipcMain.on('audio:done', (_e, msg) => {
        (0, logger_1.log)('tts.played', { id: msg?.id ?? null, ms: msg?.ms ?? null });
    });
    electron_1.ipcMain.on('tts:toggle', () => {
        state.ttsOn = !state.ttsOn;
        (0, logger_1.log)('tts.toggle', { on: state.ttsOn });
        if (!state.ttsOn && alive())
            win.webContents.send('audio:stop');
    });
    electron_1.ipcMain.handle('tts:probe', async () => (ttsRuntime ? ttsRuntime.probe() : { engine: 'none', ready: false }));
    electron_1.ipcMain.handle('tts:stats', () => (ttsRuntime ? ttsRuntime.stats() : null));
    // ---- 设置窗接线（读/写配置 + 试说一句 + 试听）----
    //
    // 配置读写全在 userConfig.ts（稀疏写入 + 白名单 + 原子写）；这里只提供"能力"：
    //   askOnce：用给定 system prompt 直连一次模型（**不写进聊天历史**，只是预览）；
    //   synthVoice：走真实 TTS 链（含缓存/回退），所以试听 = 她真会怎么说。
    const settingsApi = (0, settingsIpc_1.wireSettingsIpc)({
        root: (0, config_1.projectRoot)(),
        preload: (0, node_path_1.join)(__dirname, '../preload/index.js'),
        // 每次读都重新 loadConfig()：保存后立刻反映新值（占位符/名字/语音/人格都靠它）
        reloadConfig: () => {
            cfg = (0, config_1.loadConfig)();
            return cfg;
        },
        currentState: () => currentPetState,
        askOnce: async (systemPrompt, userText, c) => {
            const t0 = Date.now();
            const url = c.llm.baseUrl.replace(/\/+$/, '') + '/chat/completions';
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${c.secrets.apiKey}`
                },
                body: JSON.stringify({
                    model: c.llm.model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userText }
                    ],
                    temperature: c.llm.temperature,
                    max_tokens: Math.min(200, c.llm.maxTokens),
                    stream: false
                }),
                signal: AbortSignal.timeout(20000)
            });
            if (!res.ok)
                throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
            const data = (await res.json());
            const reply = data.choices?.[0]?.message?.content?.trim() ?? '';
            (0, logger_1.log)('settings.previewPersonality', { chars: systemPrompt.length, replyChars: reply.length });
            return { reply, ms: Date.now() - t0 };
        },
        synthVoice: async (text) => {
            if (!ttsRuntime)
                return { ok: false, error: 'tts 未初始化' };
            const r = await ttsRuntime.synth(text);
            if (!r.ok || !r.audio || !r.mime)
                return { ok: false, error: r.error ?? 'no audio' };
            return {
                ok: true,
                dataUrl: `data:${r.mime};base64,${r.audio.toString('base64')}`,
                engine: r.engine,
                ms: r.ms
            };
        },
        clearCache: () => {
            const dir = (0, node_path_1.join)((0, config_1.projectRoot)(), '.local', 'tts-cache');
            let freed = 0;
            try {
                for (const f of (0, node_fs_1.readdirSync)(dir)) {
                    const p = (0, node_path_1.join)(dir, f);
                    try {
                        freed += (0, node_fs_1.statSync)(p).size;
                        (0, node_fs_1.unlinkSync)(p);
                    }
                    catch {
                        /* ignore */
                    }
                }
            }
            catch {
                /* 目录可能不存在 */
            }
            (0, logger_1.log)('settings.clearCache', { freedBytes: freed });
            return { ok: true, freedBytes: freed };
        }
    });
    settingsCtl.open = settingsApi.open;
    electron_1.ipcMain.handle('game:list', () => story.list());
    electron_1.ipcMain.handle('game:view', () => story.view());
    electron_1.ipcMain.handle('game:start', async (_e, id) => {
        const list = story.list();
        const engineId = typeof id === 'string' && id ? id : list[0]?.id;
        if (!engineId)
            throw new Error('没有可用的剧本');
        (0, logger_1.log)('game.start', { engineId });
        return story.start(engineId);
    });
    electron_1.ipcMain.handle('game:say', async (_e, text) => story.say(String(text ?? '')));
    electron_1.ipcMain.handle('game:choose', async (_e, id) => story.choose(String(id ?? '')));
    electron_1.ipcMain.handle('game:stop', () => {
        stopGameTyping();
        story.stop();
        (0, logger_1.log)('game.stop');
        return story.view();
    });
    (0, logger_1.log)('app.ready', {
        profile: PROFILE,
        selfcheck: SELFCHECK,
        hasApiKey: cfg.secrets.apiKey.length > 0,
        budget: budget.snapshot(),
        stories: story.list().map((s) => s.id)
    });
    if (SELFCHECK) {
        await (0, selfcheck_1.runSelfcheck)(win, cfg, PROFILE);
        electron_1.app.exit(0);
    }
});
electron_1.app.on('will-quit', () => electron_1.globalShortcut.unregisterAll());
electron_1.app.on('window-all-closed', () => {
    if (process.platform !== 'darwin')
        electron_1.app.quit();
});
