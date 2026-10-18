"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VoiceBridge = void 0;
/**
 * 语音桥：常驻一个 Python 进程跑 faster-whisper，用 stdin 控制「开始/停止录音」。
 *
 * 为什么常驻而不是每次新起进程：
 *   模型加载要 1-3 秒。每条语音都重来一次的话，按住说话会等很久。
 *   常驻进程只在第一次加载，之后每次识别是毫秒级。
 *
 * 为什么用 stdin 而不是信号：
 *   Windows 上给子进程发自定义信号很麻烦，而且 DSH 沙箱禁命名管道。
 *   stdin 一行一条命令最简单可靠。
 *
 * 协议见 tools/voice_recorder.py 的文档注释。
 *
 * ⚠️ 只做**输入**：录 + 识别 + 把文字交给上层。不发任何游戏/系统动作。
 */
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const logger_1 = require("./logger");
class VoiceBridge {
    d;
    child = null;
    buf = '';
    ready = false;
    recording = false;
    /** 主动停止（退出程序）时为 true —— 这时不该重启 */
    stopping = false;
    /** 连续重启次数，用于退避 */
    restarts = 0;
    /**
     * 最近一次子进程崩溃的 stderr 尾巴。
     * 为什么要留：python 崩了只报个 exit code 没用 —— 真实原因是
     * `No module named 'sounddevice'` 这类依赖缺失，必须把它写进日志，
     * 否则用户只看到"语音没反应 + 一直响"。
     */
    stderrTail = '';
    retryTimer = null;
    /**
     * 准备就绪 / 失去就绪时通知外部。
     * 用途：主进程据此**动态注册/注销热键** —— 语音挂掉时把波浪键还给系统，
     * 否则键被吞掉、录音又没起来，用户看到的是"按了完全没反应"。
     *
     * 构造之后可重新赋值（主进程在 bridge 构造完才定义好开关函数）。
     */
    onReadyChange;
    constructor(deps) {
        this.d = deps;
        this.onReadyChange = () => { };
    }
    get isReady() {
        return this.ready;
    }
    get isRecording() {
        return this.recording;
    }
    start() {
        if (this.child)
            return;
        const { opts } = this.d;
        const script = (0, node_path_1.join)(opts.root, 'tools', 'voice_recorder.py');
        if (!(0, node_fs_1.existsSync)(script)) {
            this.d.onError('找不到 tools/voice_recorder.py');
            return;
        }
        try {
            const child = (0, node_child_process_1.spawn)(opts.python, [script, '--model', opts.model, '--lang', opts.language, '--device', opts.device,
                '--compute-type', opts.computeType,
                '--min-ms', String(opts.minMs),
                // 录音器自己会在静音时停（见 voice_recorder.py 的看门狗），
                // 所以上层只发一次 START，不需要发 STOP —— 这样才不受按键重复影响。
                '--max-ms', String(opts.maxMs),
                '--silence-ms', String(opts.silenceMs),
                // 长按模式：录音器**自己轮询热键**（GetAsyncKeyState），按下开始、松开结束。
                // 为什么交给 Python：Electron 的 globalShortcut 拿不到按键松开事件，
                // 做不了真正的长按；而 ctypes 调 user32 不需要任何新依赖。
                ...(opts.pushToTalk ? ['--ptt', '--ptt-key', opts.pttKey] : [])], {
                cwd: opts.root,
                env: { ...process.env, HF_ENDPOINT: 'https://hf-mirror.com' },
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true
            });
            this.child = child;
            (0, logger_1.log)('voice.bridgeStart', { pid: child.pid, model: opts.model, device: opts.device });
            child.stdout?.setEncoding('utf8');
            child.stdout?.on('data', (c) => this.feed(c));
            child.stderr?.setEncoding('utf8');
            child.stderr?.on('data', (c) => {
                const t = String(c).trim();
                if (t) {
                    this.stderrTail = (this.stderrTail + ' ' + t).slice(-2000);
                    (0, logger_1.log)('voice.bridgeStderr', { text: t.slice(0, 300) });
                }
            });
            child.on('error', (e) => {
                (0, logger_1.log)('voice.bridgeError', { message: String(e) });
                this.d.onError(String(e));
                this.child = null;
                this.setReady(false);
            });
            child.on('exit', (code) => {
                (0, logger_1.log)('voice.bridgeExit', { code, stopping: this.stopping, restarts: this.restarts });
                this.child = null;
                this.recording = false;
                this.setReady(false);
                if (this.stopping)
                    return;
                // ⚠️ 自动重启，但**必须有上限**。
                //    没有上限的后果（2026-10-18 实测）：打包版没有 python/sounddevice 时，
                //    子进程每 3 秒崩一次 → 无限重试 + 每次一条报错提示音，用户听到的是"一直响"。
                //    这里连续失败 3 次就停，并把原因写进日志（`voice.disabled`），
                //    用户想重试可以点托盘「语音」开关（会重置计数）。
                this.restarts++;
                if (this.restarts >= 3) {
                    (0, logger_1.log)('voice.disabled', {
                        reason: '连续失败 3 次，停止自动重试（语音识别需要 python + sounddevice；见 README）',
                        exitCode: code,
                        stderrTail: this.stderrTail.slice(-400)
                    });
                    this.d.onStatus({ kind: 'disabled', exitCode: code });
                    this.restarts = 0;
                    return;
                }
                const delay = Math.min(60000, 3000 * Math.min(this.restarts, 20));
                this.d.onStatus({
                    kind: 'restarting',
                    attempt: this.restarts,
                    exitCode: code,
                    retryInMs: delay
                });
                this.retryTimer = setTimeout(() => {
                    this.retryTimer = null;
                    (0, logger_1.log)('voice.bridgeRetry', { attempt: this.restarts });
                    this.start();
                }, delay);
            });
        }
        catch (e) {
            // 沙箱里 spawn 会 EPERM —— 不让它把桌宠带崩
            (0, logger_1.log)('voice.bridgeSpawnFail', { message: String(e) });
            this.d.onError(String(e));
            this.child = null;
            this.setReady(false);
        }
    }
    /** 统一维护 ready 状态并通知外部（外部据此开关热键） */
    setReady(v) {
        if (this.ready === v)
            return;
        this.ready = v;
        try {
            this.onReadyChange(v);
        }
        catch {
            /* 外部回调不该影响桥自身 */
        }
    }
    /** 按下开始录（窗口聚焦时用，配合 keyup 才是真正的"按住说话"） */
    beginCapture() {
        if (!this.ready || this.recording || !this.child?.stdin?.writable) {
            (0, logger_1.log)('voice.beginBlocked', {
                ready: this.ready,
                recording: this.recording,
                writable: !!this.child?.stdin?.writable
            });
            return;
        }
        this.recording = true;
        this.child.stdin.write('START\n');
        (0, logger_1.log)('voice.begin', {});
    }
    /** 提前结束录音（可选）。正常情况下录音器会自己在静音时停，不需要调用。 */
    endCapture() {
        if (!this.recording || !this.child?.stdin?.writable)
            return;
        this.recording = false;
        this.child.stdin.write('STOP\n');
        (0, logger_1.log)('voice.end', { manual: true });
    }
    stop() {
        // stopping=true 很重要：不设的话退出程序时子进程被杀会触发重启，
        // 桌宠都关了还在拉新进程。
        this.stopping = true;
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        this.setReady(false);
        if (!this.child)
            return;
        try {
            this.child.stdin?.write('QUIT\n');
            this.child.kill();
        }
        catch {
            /* 忽略 */
        }
        this.child = null;
        this.recording = false;
    }
    /** 按行切 JSONL —— 和 gameBridge 同一个坑：跨 chunk 的半行要缓冲 */
    feed(chunk) {
        this.buf += chunk;
        let nl;
        while ((nl = this.buf.indexOf('\n')) >= 0) {
            const line = this.buf.slice(0, nl).trim();
            this.buf = this.buf.slice(nl + 1);
            if (!line)
                continue;
            let o;
            try {
                o = JSON.parse(line);
            }
            catch {
                continue;
            }
            const kind = String(o.kind ?? '');
            if (kind === 'ready') {
                // 加载成功 = 这一轮重启成功，重置退避计数
                this.restarts = 0;
                this.setReady(true);
                this.d.onStatus(o);
                return;
            }
            // ⚠️⚠️ 关键：录音结束的三种信号都必须**复位 recording 闸门**。
            //
            // 踩过的坑（现象：只能识别一次，之后按热键毫无反应）：
            //   改成「自动停止」之后，主进程**不再调用 endCapture()**，
            //   而 recording 只在 endCapture() 里被复位 —— 于是第一次按完之后
            //   this.recording 永远是 true，beginCapture() 里的
            //   `if (this.recording) return` 把后面每一次按键全挡住了。
            if (kind === 'result' || kind === 'empty' || kind === 'error') {
                this.recording = false;
            }
            // ⚠️ 长按按键的上下沿**必须记进日志**。
            //    为什么：DSH 的 agent shell 跑在非交互式会话里，GetAsyncKeyState
            //    在那里**一个键都读不到**（实测 A/空格/波浪/Shift 全 0），
            //    所以"松手不停止"这个 bug 只能在**真机**上定位。
            //    有了这两条日志，用户按一次键，就能直接看出是
            //    「看不到松开」还是「看到了但没生效」。
            if (kind === 'ptt-key') {
                (0, logger_1.log)('voice.pttKey', { down: o.down === true });
            }
            if (kind === 'micReleased') {
                (0, logger_1.log)('voice.micReleased', { active: o.active === true, why: o.why });
            }
            if (kind === 'cacheInvalid') {
                (0, logger_1.log)('voice.cacheInvalid', { device: o.device });
            }
            if (kind === 'result') {
                const text = String(o.text ?? '').trim();
                if (text) {
                    this.d.onText(text, {
                        ms: Number(o.ms ?? 0),
                        audioMs: Number(o.audioMs ?? 0)
                    });
                }
                else {
                    this.d.onStatus({ kind: 'empty', reason: 'blank' });
                }
            }
            else if (kind === 'error') {
                this.d.onError(String(o.message ?? '未知错误'));
            }
            else {
                this.d.onStatus(o);
            }
        }
    }
}
exports.VoiceBridge = VoiceBridge;
