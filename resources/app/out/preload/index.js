"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const api = {
    ping: () => electron_1.ipcRenderer.invoke('pet:ping'),
    getConfig: () => electron_1.ipcRenderer.invoke('pet:config'),
    notifyReady: () => electron_1.ipcRenderer.send('pet:rendererReady'),
    onState: (cb) => {
        const handler = (_e, s) => cb(s);
        electron_1.ipcRenderer.on('pet:state', handler);
        return () => electron_1.ipcRenderer.removeListener('pet:state', handler);
    },
    /**
     * 拖动：渲染层只发信号 + 两个位置，真正的坐标由主进程算。
     *
     *   anchor  —— 抓取锚点（画在 held 素材里的那只手捏住呆毛的点）在窗口内的位置
     *   pointer —— 指针在窗口内的位置，主进程用它反推「光标读数 → DIP」的换算系数
     *
     * 为什么要 pointer：显示器有缩放（本机 1.5x），而 getCursorScreenPoint() 与
     * setPosition() 不保证同一坐标空间。不校准的话每帧多走一个缩放系数，
     * 表现为窗口越拖越偏、最后 y 冲出 int32 抛 "conversion failure"。
     */
    dragStart: (msg) => electron_1.ipcRenderer.send('pet:dragStart', msg),
    dragMove: () => electron_1.ipcRenderer.send('pet:dragMove'),
    /** 返回 { moved }，渲染层据此区分点击与拖动 */
    dragEnd: () => electron_1.ipcRenderer.invoke('pet:dragEnd'),
    /** 主进程判定「真的拖起来了」时触发，渲染层据此抓手 */
    onDragMoved: (cb) => {
        const handler = () => cb();
        electron_1.ipcRenderer.on('pet:dragMoved', handler);
        return () => electron_1.ipcRenderer.removeListener('pet:dragMoved', handler);
    },
    /** 退出桌宠（等价于托盘菜单的「退出」） */
    quit: () => electron_1.ipcRenderer.send('pet:quit'),
    /** 弹出右键菜单（含退出） */
    showMenu: () => electron_1.ipcRenderer.send('pet:showMenu'),
    /**
     * 拖动诊断：把渲染层的视口信息（精灵实际画在哪、多大）报给主进程。
     * 只在 config.debug.dragCapture 打开时才会写盘，平时是空操作。
     */
    debug: (msg) => electron_1.ipcRenderer.send('pet:debug', msg),
    /**
     * 打开聊天窗（Day 1 步 3）。
     * 已开着就聚焦，不会开出第二个。
     */
    openChat: () => electron_1.ipcRenderer.send('pet:openChat'),
    /**
     * 把一条聊天记录报给主进程。
     *
     * 为什么记录要放主进程：聊天窗关掉后销毁，下次打开是全新渲染层，
     * DOM 里的消息会全丢（用户实测发现）。主进程持有记录，
     * 重开时通过 chat:history 推回来。
     */
    chatAppend: (e) => electron_1.ipcRenderer.send('chat:append', e),
    /** 拉取历史记录（渲染层加载时调用） */
    chatHistory: () => electron_1.ipcRenderer.invoke('chat:history'),
    /**
     * 屏幕感知：请她**看一眼屏幕**（按需单次，不常驻）。
     * 主进程会在抓屏**之前**检查三道闸门（配置开关 / 托盘暂停 / 前台窗口黑名单），
     * 命中任何一道都不会抓屏，直接返回 `{ ok:false, error }`。
     * @param question 想让模型回答的问题（留空 = "我在做什么"）
     */
    screenLook: (question) => electron_1.ipcRenderer.invoke('screen:look', question),
    /**
     * 通话：把合成好的音频交给页面播放（页面才能拿到 onended 去驱动口型）。
     * 页面播完必须调 `audioDone({ id, ms })`，主进程据此记日志/排查。
     */
    onAudioPlay: (fn) => {
        const h = (_e, p) => fn(p);
        electron_1.ipcRenderer.on('audio:play', h);
        return () => electron_1.ipcRenderer.removeListener('audio:play', h);
    },
    /** 打断当前播放（新的回复来了 / 用户点了静音 / 关窗） */
    onAudioStop: (fn) => {
        const h = () => fn();
        electron_1.ipcRenderer.on('audio:stop', h);
        return () => electron_1.ipcRenderer.removeListener('audio:stop', h);
    },
    /** 播放完成回报 */
    audioDone: (p) => electron_1.ipcRenderer.send('audio:done', p),
    /** 语音开关（聊天窗/未来的设置界面也能切） */
    ttsToggle: () => electron_1.ipcRenderer.send('tts:toggle'),
    /** 探活（gpt-sovits 时能看出本地服务在不在） */
    ttsProbe: () => electron_1.ipcRenderer.invoke('tts:probe'),
    /** 缓存/引擎统计（帧进度条、诊断用） */
    ttsStats: () => electron_1.ipcRenderer.invoke('tts:stats'),
    /**
     * 互动叙事小游戏（`src/game/` 的接口层）。
     * 剧本逻辑在 `src/game/stories/*`，这里只是把主进程的 StoryHost 暴露给聊天窗。
     */
    game: {
        /** 有哪些剧本 */
        list: () => electron_1.ipcRenderer.invoke('game:list'),
        /** 当前会话快照（没开局时 active=false） */
        view: () => electron_1.ipcRenderer.invoke('game:view'),
        /** 开一局（不传 id = 用第一个剧本）；reset 语义由主进程决定（当前 = 读档继续） */
        start: (id) => electron_1.ipcRenderer.invoke('game:start', id),
        /** 玩家自由输入 */
        say: (text) => electron_1.ipcRenderer.invoke('game:say', text),
        /** 玩家点选项 */
        choose: (choiceId) => electron_1.ipcRenderer.invoke('game:choose', choiceId),
        /** 结束这一局 */
        stop: () => electron_1.ipcRenderer.invoke('game:stop'),
        /** 会话变化（每拍一次） */
        onView: (cb) => {
            const handler = (_e, v) => cb(v);
            electron_1.ipcRenderer.on('game:view', handler);
            return () => electron_1.ipcRenderer.removeListener('game:view', handler);
        }
    },
    // ---- 会话（Day 1 步 5-6）----
    // 两个窗口共用同一套：主进程把同一份流式文本广播给桌宠窗和聊天窗。
    /** 发一条用户消息 */
    chatSend: (text) => electron_1.ipcRenderer.send('chat:send', text),
    /** 取消当前这一轮 */
    chatCancel: () => electron_1.ipcRenderer.send('chat:cancel'),
    /** 流式增量。返回取消订阅函数（窗口销毁前应调用，避免监听器堆积） */
    onDelta: (fn) => {
        const h = (_e, p) => fn(p);
        electron_1.ipcRenderer.on('chat:delta', h);
        return () => electron_1.ipcRenderer.removeListener('chat:delta', h);
    },
    /** 首字到达（毫秒） */
    onFirstToken: (fn) => {
        const h = (_e, p) => fn(p);
        electron_1.ipcRenderer.on('chat:firstToken', h);
        return () => electron_1.ipcRenderer.removeListener('chat:firstToken', h);
    },
    /**
     * 桌宠的"额外动作"通道（rig 页专用）：动态表情 / 聆听 / 思考。
     * 抽成一条通道而不是三条 IPC，是因为它们都是"给角色的临时指令"，
     * 而且帧路线没有动态表情 —— 一条通道忽略起来最省事。
     */
    onExtra: (fn) => {
        const h = (_e, p) => fn(p);
        electron_1.ipcRenderer.on('pet:extra', h);
        return () => electron_1.ipcRenderer.removeListener('pet:extra', h);
    },
    /** 一轮结束 */
    onDone: (fn) => {
        const h = (_e, p) => fn(p);
        electron_1.ipcRenderer.on('chat:done', h);
        return () => electron_1.ipcRenderer.removeListener('chat:done', h);
    },
    /** 出错 */
    onError: (fn) => {
        const h = (_e, p) => fn(p);
        electron_1.ipcRenderer.on('chat:error', h);
        return () => electron_1.ipcRenderer.removeListener('chat:error', h);
    },
    /** 状态机变化（thinking / talking / idle / error） */
    onMood: (fn) => {
        const h = (_e, m) => fn(m);
        electron_1.ipcRenderer.on('chat:mood', h);
        electron_1.ipcRenderer.on('pet:mood', h);
        return () => {
            electron_1.ipcRenderer.removeListener('chat:mood', h);
            electron_1.ipcRenderer.removeListener('pet:mood', h);
        };
    },
    // ---- 语音输入（步 7）----
    // ⚠️ 只做**输入**：录 + 识别 + 交文字。不发任何系统/游戏动作。
    /** 切换录音（热键是切换式：按一下开始，再按一下停止） */
    voiceToggle: () => electron_1.ipcRenderer.send('voice:toggle'),
    /** 按下开始录（窗口聚焦时用，配合 keyup 才是真正的"按住说话"） */
    voiceBegin: () => electron_1.ipcRenderer.send('voice:begin'),
    /** 松开停止并识别 */
    voiceEnd: () => electron_1.ipcRenderer.send('voice:end'),
    /** 查语音是否就绪 */
    voiceState: () => electron_1.ipcRenderer.invoke('voice:state'),
    /** 订阅语音状态（loading / ready / recording / empty / error） */
    onVoiceStatus: (fn) => {
        const h = (_e, s) => fn(s);
        electron_1.ipcRenderer.on('voice:status', h);
        return () => electron_1.ipcRenderer.removeListener('voice:status', h);
    },
    /** 订阅识别结果 */
    onVoiceText: (fn) => {
        const h = (_e, p) => fn(p);
        electron_1.ipcRenderer.on('voice:text', h);
        return () => electron_1.ipcRenderer.removeListener('voice:text', h);
    },
    // ---- 游戏桥（轨道 B · B-4，只读）----
    /** 主动拉一次最新游戏状态（渲染层加载时用，省得等下一个采样周期） */
    gameState: () => electron_1.ipcRenderer.invoke('game:state'),
    /** 订阅游戏状态采样 */
    onGameState: (fn) => {
        const h = (_e, s) => fn(s);
        electron_1.ipcRenderer.on('game:state', h);
        return () => electron_1.ipcRenderer.removeListener('game:state', h);
    },
    /** 订阅游戏桥事件（spawn / login / kicked / error / end / bridge-exit） */
    onGameEvent: (fn) => {
        const h = (_e, p) => fn(p);
        electron_1.ipcRenderer.on('game:event', h);
        return () => electron_1.ipcRenderer.removeListener('game:event', h);
    },
    // ---- 设置窗 ----
    //
    // 契约见 docs/settings-contract.md。注意 `saveSettings` 只传**改动过的键**（稀疏写入），
    // 后端会做白名单校验并返回 rejected/needsRestart。
    /** 打开设置窗（托盘里也有入口） */
    openSettings: () => electron_1.ipcRenderer.invoke('settings:open'),
    /** 取表单模型（后端出字段描述，前端只渲染） */
    getSettings: () => electron_1.ipcRenderer.invoke('settings:get'),
    /** 保存改动（只传改动键） */
    saveSettings: (patch) => electron_1.ipcRenderer.invoke('settings:save', patch),
    /** 恢复默认（清空 user-config.json） */
    resetSettings: () => electron_1.ipcRenderer.invoke('settings:reset'),
    /** 试说一句：返回她的回复 + **实际发出的 system prompt** */
    previewPersonality: (personality, sample) => electron_1.ipcRenderer.invoke('settings:previewPersonality', { personality, sample }),
    /** 试听：走真实 TTS 链（含缓存与回退） */
    previewVoice: (text) => electron_1.ipcRenderer.invoke('settings:previewVoice', { text }),
    /** 清 TTS 缓存 */
    clearCache: () => electron_1.ipcRenderer.invoke('settings:clearCache'),
    /** 打开日志目录 */
    openLogDir: () => electron_1.ipcRenderer.invoke('settings:openLogDir'),
    /** 重启应用（改热键后需要） */
    restartApp: () => electron_1.ipcRenderer.invoke('settings:restart'),
    /** 订阅配置变更（多窗口同步） */
    onSettingsChanged: (fn) => {
        const h = (_e, p) => fn(p);
        electron_1.ipcRenderer.on('settings:changed', h);
        return () => electron_1.ipcRenderer.removeListener('settings:changed', h);
    },
    // ---- 《后室漫游：回到现实》互动小说 ----
    //
    // ⚠️ 广播通道叫 `backrooms:event`，不能复用上面的 `game:event`：
    //    那个是 MC 游戏桥（spawn/login/…）的通道，混在一起会让聊天窗的 HUD 收到不明事件。
    /** 打开游戏窗口（托盘里也有入口，这里是给界面按钮用的） */
    backroomsOpen: () => electron_1.ipcRenderer.invoke('game:open'),
    backroomsClose: () => electron_1.ipcRenderer.invoke('game:close'),
    backroomsOpened: () => electron_1.ipcRenderer.invoke('game:opened'),
    /** 订阅游戏里发生的事（node/item/gem/gem-dim/check/hurt/ending） */
    onBackroomsEvent: (fn) => {
        const h = (_e, ev) => fn(ev);
        electron_1.ipcRenderer.on('backrooms:event', h);
        return () => electron_1.ipcRenderer.removeListener('backrooms:event', h);
    },
    // ---- 通关结算页（B1）----
    /** 结算数据（原石/亲和/用时/结局种类…） */
    finishData: () => electron_1.ipcRenderer.invoke('finish:data'),
    /** 再玩一次：清档并重开游戏 */
    finishReplay: () => electron_1.ipcRenderer.invoke('finish:replay'),
    /** 回到桌面：关结算窗 + 桌宠说一句收尾 */
    finishClose: () => electron_1.ipcRenderer.invoke('finish:back'),
    /** 结算数据刷新（窗口已开着又通关一次时） */
    onFinishRefresh: (fn) => {
        const h = () => fn();
        electron_1.ipcRenderer.on('finish:refresh', h);
        return () => electron_1.ipcRenderer.removeListener('finish:refresh', h);
    }
};
electron_1.contextBridge.exposeInMainWorld('pet', api);
