"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isBlocked = void 0;
exports.projectRoot = projectRoot;
exports.loadConfig = loadConfig;
exports.assetPath = assetPath;
exports.resolvePetFrames = resolvePetFrames;
const electron_1 = require("electron");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const userConfig_1 = require("./userConfig");
const logger_1 = require("./logger");
/** 项目根目录：开发期用 electron . 启动时即项目目录 */
function projectRoot() {
    return electron_1.app.getAppPath();
}
function readDotEnv(path) {
    const out = {};
    if (!(0, node_fs_1.existsSync)(path))
        return out;
    for (const line of (0, node_fs_1.readFileSync)(path, 'utf8').split(/\r?\n/)) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!m)
            continue;
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
        }
        out[m[1]] = v;
    }
    return out;
}
/** 取数字，非法（缺失/NaN/Infinity）时用兜底值 */
function num(v, fallback) {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
/** 夹到 [lo, hi] 区间。配置写歪了也不至于让程序行为失控。 */
function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}
/** 取字符串；空串/非字符串用兜底值，超长截断（配置手改歪了也不崩） */
function str(v, fallback, maxLen = 1024) {
    if (typeof v !== 'string')
        return fallback;
    if (v.trim() === '')
        return fallback;
    return v.length > maxLen ? v.slice(0, maxLen) : v;
}
/** 点分路径写值（`a.b`），中间层不存在就建对象 */
function setDeep(target, key, value) {
    const parts = key.split('.');
    let cur = target;
    for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        const next = cur[p];
        if (next === null || typeof next !== 'object' || Array.isArray(next))
            cur[p] = {};
        cur = cur[p];
    }
    cur[parts[parts.length - 1]] = value;
}
/**
 * 用户配置层：`config/default.json` ← `userData/user-config.json`
 * （`config.ts` 之后再用环境变量覆盖 `llm.*` / `secrets.apiKey`，那就是三层里的最高层）。
 *
 * 规则（契约 §5）：
 *   · **只覆盖白名单里的键**（`userConfig.ts` 的 `WHITELIST`）；其余原样，`_comment_*` 也不动；
 *   · 值类型不对 → 忽略该键 + 记 `userconfig.badType`，用默认值；
 *   · 数字按字段的 `[min,max]` 夹一遍，非法值不会让程序行为失控；
 *   · 任何异常都只记日志，不往上抛（读配置失败不能让桌宠起不来）。
 */
function applyUserOverrides(base, userDir) {
    let flat = {};
    try {
        flat = (0, userConfig_1.flattenUserConfig)(userDir);
    }
    catch (e) {
        (0, logger_1.log)('userconfig.error', { where: 'loadConfig', err: e instanceof Error ? e.message : String(e) });
        return base;
    }
    if (Object.keys(flat).length === 0)
        return base;
    // 深拷贝：不动 default.json 解析出来的原对象（里面有 _comment_*，必须原样留着）
    const out = JSON.parse(JSON.stringify(base));
    for (const rule of userConfig_1.WHITELIST) {
        if (!(rule.key in flat))
            continue;
        const v = flat[rule.key];
        const ok = rule.kind === 'number'
            ? typeof v === 'number' && Number.isFinite(v)
            : rule.kind === 'boolean'
                ? typeof v === 'boolean'
                : typeof v === 'string';
        if (!ok) {
            (0, logger_1.log)('userconfig.badType', { key: rule.key, expected: rule.kind, got: typeof v });
            continue;
        }
        if (rule.kind === 'select' && rule.options && !rule.options.includes(String(v))) {
            (0, logger_1.log)('userconfig.badType', { key: rule.key, expected: rule.options.join('|'), got: v });
            continue;
        }
        setDeep(out, rule.key, rule.kind === 'number' ? clamp(v, rule.min ?? -Infinity, rule.max ?? Infinity) : v);
    }
    return out;
}
function loadConfig() {
    const root = projectRoot();
    const base = JSON.parse((0, node_fs_1.readFileSync)((0, node_path_1.join)(root, 'config', 'default.json'), 'utf8'));
    // 第二层：用户配置（稀疏、白名单）。userData = app.getPath('userData')，
    // 打包版由启动器设成 <exe目录>\userdata —— 写到只读的 resources/app 里会存不住。
    const raw = applyUserOverrides(base, electron_1.app.getPath('userData'));
    // `.env` 查三处（前面的优先），这样绿色版可以"把 .env 丢在 exe 旁边"就用：
    //   ① 应用目录（开发时就是项目根）
    //   ② exe 所在目录（绿色版：用户把 .env 放在 桌宠.exe 旁边）
    //   ③ userData（启动器设的是 <exe>\userdata；设置界面以后也写这里）
    // 打包版实测 hasApiKey:false —— 就是因为只查了 ①，而包里的 ① 不带 .env。
    const env = readDotEnv([
        (0, node_path_1.join)(root, '.env'),
        (0, node_path_1.join)((0, node_path_1.dirname)(process.execPath), '.env'),
        (0, node_path_1.join)(electron_1.app.getPath('userData'), '.env')
    ].find((p) => (0, node_fs_1.existsSync)(p)) ?? (0, node_path_1.join)(root, '.env'));
    return {
        pet: {
            id: raw.pet?.id ?? '',
            // 渲染路线：配了就用配的，没配默认 'rig'（想回退 PNG 帧就改成 'frames'）
            renderer: raw.pet?.renderer === 'frames' ? 'frames' : 'rig',
            scheme: typeof raw.pet?.scheme === 'string' && raw.pet.scheme ? raw.pet.scheme : 'deepseek',
            rigScale: typeof raw.pet?.rigScale === 'number' ? raw.pet.rigScale : 1
        },
        vision: {
            // 默认关：屏幕感知要读屏幕，不该一装好就开着
            enabled: raw.vision?.enabled === true,
            model: typeof raw.vision?.model === 'string' && raw.vision.model ? raw.vision.model : 'deepseek-v4-flash-vision-exp',
            maxWidth: typeof raw.vision?.maxWidth === 'number' ? raw.vision.maxWidth : 1280
        },
        tts: {
            enabled: raw.tts?.enabled !== false,
            engine: raw.tts?.engine === 'gpt-sovits' ? 'gpt-sovits' : 'edge',
            voice: typeof raw.tts?.voice === 'string' && raw.tts.voice ? raw.tts.voice : 'zh-CN-XiaoyiNeural',
            rate: typeof raw.tts?.rate === 'string' ? raw.tts.rate : '-15%',
            pitch: typeof raw.tts?.pitch === 'string' ? raw.tts.pitch : '-10Hz',
            polish: raw.tts?.polish !== false,
            maxChars: typeof raw.tts?.maxChars === 'number' ? raw.tts.maxChars : 120,
            cacheMB: typeof raw.tts?.cacheMB === 'number' ? raw.tts.cacheMB : 50,
            timeoutMs: typeof raw.tts?.timeoutMs === 'number' ? raw.tts.timeoutMs : 20000,
            gptSovits: {
                url: typeof raw.tts?.gptSovits?.url === 'string' ? raw.tts.gptSovits.url : 'http://127.0.0.1:9880',
                refAudio: typeof raw.tts?.gptSovits?.refAudio === 'string' ? raw.tts.gptSovits.refAudio : '',
                promptText: typeof raw.tts?.gptSovits?.promptText === 'string' ? raw.tts.gptSovits.promptText : '',
                promptLang: typeof raw.tts?.gptSovits?.promptLang === 'string' ? raw.tts.gptSovits.promptLang : 'zh',
                textLang: typeof raw.tts?.gptSovits?.textLang === 'string' ? raw.tts.gptSovits.textLang : 'zh',
                emotionPrefix: typeof raw.tts?.gptSovits?.emotionPrefix === 'string'
                    ? raw.tts.gptSovits.emotionPrefix : '[平静][慵懒][微微疲惫][自信]',
                temperature: typeof raw.tts?.gptSovits?.temperature === 'number' ? raw.tts.gptSovits.temperature : 0.8,
                topK: typeof raw.tts?.gptSovits?.topK === 'number' ? raw.tts.gptSovits.topK : 10,
                topP: typeof raw.tts?.gptSovits?.topP === 'number' ? raw.tts.gptSovits.topP : 0.9,
                speed: typeof raw.tts?.gptSovits?.speed === 'number' ? raw.tts.gptSovits.speed : 1.0,
                sampleSteps: typeof raw.tts?.gptSovits?.sampleSteps === 'number' ? raw.tts.gptSovits.sampleSteps : 16,
                polish: raw.tts?.gptSovits?.polish === true,
                textSplit: typeof raw.tts?.gptSovits?.textSplit === 'string' ? raw.tts.gptSovits.textSplit : 'cut0',
                fragmentInterval: typeof raw.tts?.gptSovits?.fragmentInterval === 'number'
                    ? raw.tts.gptSovits.fragmentInterval : 0.05,
                timeoutMs: typeof raw.tts?.gptSovits?.timeoutMs === 'number' ? raw.tts.gptSovits.timeoutMs : 30000
            }
        },
        window: raw.window,
        hotkeys: {
            toggleScreenPause: raw.hotkeys.toggleScreenPause,
            toggleVisible: raw.hotkeys.toggleVisible,
            quit: raw.hotkeys.quit,
            // 兜底：配置文件里没写也能用
            chat: typeof raw.hotkeys.chat === 'string' && raw.hotkeys.chat ? raw.hotkeys.chat : 'CommandOrControl+Alt+C',
            // 语音默认给一个**带修饰键**的安全值。波浪键是全局热键，
            // 占住之后任何程序都打不出反引号 —— 这个取舍交给用户在配置里显式选择。
            voice: typeof raw.hotkeys.voice === 'string' ? raw.hotkeys.voice : ''
        },
        drag: {
            tilt: raw.drag?.tilt === true,
            style: raw.drag?.style === 'running' || raw.drag?.style === 'rolling' ? raw.drag.style : 'held',
            anchor: raw.drag?.anchor === 'cursor' ? 'cursor' : 'grab'
        },
        debug: { dragCapture: raw.debug?.dragCapture === true },
        privacy: { screenPaused: raw.privacy.screenPaused, blocklist: raw.privacy.blocklist ?? [] },
        budget: raw.budget,
        llm: {
            baseUrl: env.DEEPSEEK_BASE_URL || raw.llm.baseUrl,
            model: env.DEEPSEEK_MODEL || raw.llm.model,
            thinking: raw.llm.thinking,
            temperature: raw.llm.temperature,
            maxTokens: raw.llm.maxTokens,
            stream: raw.llm.stream
        },
        chat: {
            // 兜底要跟 default.json 一致，配置文件被删掉也能用
            personality: typeof raw.chat?.personality === 'string' && raw.chat.personality.trim()
                ? raw.chat.personality
                : '你是 DeepSeek 桌宠，回答简短、口语化、用中文。',
            // 夹在合理区间：太快看不出逐字，太慢像卡住
            typewriterCps: clamp(num(raw.chat?.typewriterCps, 18), 5, 60),
            minThinkingMs: clamp(num(raw.chat?.minThinkingMs, 900), 0, 5000),
            historyLimit: clamp(num(raw.chat?.historyLimit, 12), 2, 40)
        },
        identity: {
            // 兜底与 userConfig 的白名单默认值一致：名字「鲸鱼娘」、称呼「你」，长度上限 24
            name: str(raw.identity?.name, '鲸鱼娘', 24),
            userName: str(raw.identity?.userName, '你', 24)
        },
        personality: {
            // 默认开：末尾追加【当前状态：x】。写了 false 才关。
            stateInjection: raw.personality?.stateInjection !== false
        },
        voice: {
            enabled: raw.voice?.enabled !== false,
            model: typeof raw.voice?.model === 'string' && raw.voice.model ? raw.voice.model : 'small',
            language: typeof raw.voice?.language === 'string' && raw.voice.language ? raw.voice.language : 'zh',
            device: typeof raw.voice?.device === 'string' && raw.voice.device ? raw.voice.device : 'auto',
            // 白名单校验：写歪了会让 Python 报错退出，不如这里直接兜回默认
            computeType: ['auto', 'int8', 'float32', 'float16', 'int8_float32', 'bfloat16'].includes(String(raw.voice?.computeType ?? ''))
                ? String(raw.voice.computeType)
                : 'float32',
            minMs: clamp(num(raw.voice?.minMs, 300), 100, 3000),
            maxMs: clamp(num(raw.voice?.maxMs, 15000), 1000, 60000),
            silenceMs: clamp(num(raw.voice?.silenceMs, 900), 300, 5000),
            pushToTalk: raw.voice?.pushToTalk !== false,
            pttKey: typeof raw.voice?.pttKey === 'string' && /^0x[0-9a-fA-F]{1,4}$/.test(raw.voice.pttKey)
                ? raw.voice.pttKey
                : '0xC0'
        },
        game: {
            enabled: raw.game?.enabled === true,
            host: typeof raw.game?.host === 'string' && raw.game.host ? raw.game.host : 'localhost',
            port: clamp(num(raw.game?.port, 25565), 1, 65535),
            username: typeof raw.game?.username === 'string' && raw.game.username ? raw.game.username : 'WhaleGirl',
            version: typeof raw.game?.version === 'string' && raw.game.version ? raw.game.version : '1.21.1',
            // 最短 1 秒，避免配置写错把子进程压垮
            everyMs: clamp(num(raw.game?.everyMs, 5000), 1000, 60000),
            hud: raw.game?.hud !== false
        },
        selfcheck: raw.selfcheck,
        secrets: { apiKey: env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY || '' },
        root
    };
}
/**
 * 敏感窗口黑名单判定 —— 实现在 `blocklist.ts`（那个文件不 import electron，可命令行验证）。
 * 这里 re-export 保持旧调用点（tray.ts / index.ts）不变。
 */
var blocklist_1 = require("./blocklist");
Object.defineProperty(exports, "isBlocked", { enumerable: true, get: function () { return blocklist_1.isBlocked; } });
/** 静态资源路径。渲染层无打包器，assets/ 就是唯一来源，不需要构建期拷贝。 */
function assetPath(rel) {
    return (0, node_path_1.join)(projectRoot(), 'assets', rel);
}
/** petdex 状态名 → 桌宠逻辑状态名 */
const PETDEX_TO_LOGIC = {
    idle: 'idle',
    waving: 'talking',
    jumping: 'click',
    waiting: 'thinking',
    failed: 'error'
};
/**
 * held    = 被手捏住呆毛提起来（由 v2 提示词生成，手里就画在图上）
 * running = 被拖着跑
 * rolling = 被拖着打滚
 * 这三个都是拖动时用的姿态，由 config 的 drag.style 选择用哪个。
 */
const LOGIC_STATES = ['idle', 'talking', 'click', 'thinking', 'error', 'held', 'running', 'rolling'];
/**
 * 逻辑状态 → 该状态可能对应的目录名，按优先级排列。
 *
 * 两个来源的命名不一样，必须都支持：
 *   petdex-install  -> waving / jumping / waiting / failed
 *   from-expressions -> talking / click / thinking / error（直接用逻辑名）
 * 之前只认 petdex 名，导致自制的 blue-maid 只有 idle 被识别到。
 */
const DIR_CANDIDATES = {};
for (const lg of LOGIC_STATES)
    DIR_CANDIDATES[lg] = [];
for (const [px, lg] of Object.entries(PETDEX_TO_LOGIC)) {
    if (DIR_CANDIDATES[lg])
        DIR_CANDIDATES[lg].push(px);
}
for (const lg of LOGIC_STATES)
    DIR_CANDIDATES[lg].push(lg);
/** pet-info.json 里可选的 grab 字段；缺省放在头顶正中（呆毛根部附近） */
const DEFAULT_GRAB = { x: 0.5, y: 0.05 };
function readGrab(base) {
    const p = (0, node_path_1.join)(base, 'pet-info.json');
    if (!(0, node_fs_1.existsSync)(p))
        return { ...DEFAULT_GRAB };
    try {
        const j = JSON.parse((0, node_fs_1.readFileSync)(p, 'utf8'));
        const g = j?.grab;
        if (g && typeof g.x === 'number' && typeof g.y === 'number')
            return { x: g.x, y: g.y };
    }
    catch {
        /* 解析失败就用默认值 */
    }
    return { ...DEFAULT_GRAB };
}
/**
 * 扫描 assets/pets/<id>/，把目录结构翻译成桌宠的逻辑状态。
 * 返回 null 表示该角色不存在或不完整，渲染层会回落到内置素材。
 */
function resolvePetFrames(petId) {
    if (!petId)
        return null;
    const base = (0, node_path_1.join)(projectRoot(), 'assets', 'pets', petId);
    if (!(0, node_fs_1.existsSync)(base))
        return null;
    const states = {};
    let size = null;
    for (const logicState of LOGIC_STATES) {
        for (const dirName of DIR_CANDIDATES[logicState]) {
            const dir = (0, node_path_1.join)(base, dirName);
            if (!(0, node_fs_1.existsSync)(dir))
                continue;
            const files = (0, node_fs_1.readdirSync)(dir).filter((f) => f.toLowerCase().endsWith('.png'));
            if (files.length === 0)
                continue;
            if (!size) {
                try {
                    const s = electron_1.nativeImage.createFromPath((0, node_path_1.join)(dir, files[0])).getSize();
                    if (s.width > 0 && s.height > 0)
                        size = { width: s.width, height: s.height };
                }
                catch {
                    /* 读不到就用回落尺寸 */
                }
            }
            states[logicState] = { dir: `../assets/pets/${petId}/${dirName}`, count: files.length };
            break; // 该逻辑状态已找到，不再看后面的候选名
        }
    }
    if (Object.keys(states).length === 0)
        return null;
    return { size: size ?? { width: 256, height: 256 }, states, grab: readGrab(base) };
}
