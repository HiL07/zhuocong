"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GameBridge = void 0;
/**
 * 游戏桥：起一个子进程跑 `game/probe.js --json`，把它的 JSONL 状态流
 * 转成事件转发给渲染层。
 *
 * 这是轨道 B 的 P-1/B-4 部分 —— **只读**。桥本身不下发任何游戏动作，
 * 它只是把探针的输出搬过来显示。真正的动作要等 P-2 之后，
 * 且必须走 security-guardrails 的确认流程。
 *
 * 为什么不直接 require mineflayer 进主进程：
 *   1. mineflayer 是 CommonJS + 一堆依赖，塞进 Electron 主进程会拖慢启动
 *   2. 崩了会连累整个桌宠 —— 子进程崩了只是状态停了
 *   3. 探针本来就是设计成能独立跑的（`node probe.js`），复用它
 *
 * ⚠️ Electron 里没有独立的 node 可执行文件，所以用
 *   `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 让 Electron 以纯 Node 身份跑脚本。
 *   （反过来，桌宠**自己**启动时必须删掉这个变量，否则 Electron 会变成 Node 而不开窗口。）
 */
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const logger_1 = require("./logger");
class GameBridge {
    d;
    child = null;
    buf = '';
    last = null;
    /** 主动停止（退出程序）时为 true —— 这时不该重启 */
    stopping = false;
    /** 连续重启次数，用于退避 */
    restarts = 0;
    retryTimer = null;
    /** 最近一次结束原因（探针发来的 end/kicked/error），重连时显示给用户看 */
    lastReason = '';
    constructor(deps) {
        this.d = deps;
    }
    get latest() {
        return this.last;
    }
    get running() {
        return this.child !== null && this.child.exitCode === null && !this.child.killed;
    }
    start() {
        if (this.running)
            return;
        const { opts } = this.d;
        const script = (0, node_path_1.join)(opts.root, 'game', 'probe.js');
        // ⚠️ 打包版里没有 `game/`（那是开发期的 MC 服务端桥接，112 MB，不进包）。
        //    不判断就会 spawn 失败并写进日志，看起来像"打包坏了"——
        //    实际只是这个可选功能不存在。这里显式降级。
        if (!(0, node_fs_1.existsSync)(script)) {
            (0, logger_1.log)('game.bridgeDisabled', { reason: 'probe.js 不存在（打包版未包含 game/）', script });
            return;
        }
        const args = [
            script,
            '--json',
            '--host', opts.host,
            '--port', String(opts.port),
            '--user', opts.username,
            '--version', opts.version,
            '--every', String(opts.everyMs)
        ];
        try {
            const child = (0, node_child_process_1.spawn)(process.execPath, args, {
                cwd: (0, node_path_1.join)(opts.root, 'game'),
                env: {
                    ...process.env,
                    // 让 Electron 以纯 Node 身份运行这个脚本
                    ELECTRON_RUN_AS_NODE: '1'
                },
                // 只读管道：忽略 stdin，读 stdout/stderr
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true
            });
            this.child = child;
            (0, logger_1.log)('game.bridgeStart', { pid: child.pid, host: opts.host, port: opts.port, user: opts.username });
            child.stdout?.setEncoding('utf8');
            child.stdout?.on('data', (chunk) => this.feed(chunk));
            child.stderr?.setEncoding('utf8');
            child.stderr?.on('data', (chunk) => {
                // stderr 只记日志，不往渲染层灌 —— 里面常有非致命噪音
                const text = String(chunk).trim();
                if (text)
                    (0, logger_1.log)('game.bridgeStderr', { text: text.slice(0, 300) });
            });
            child.on('error', (err) => {
                (0, logger_1.log)('game.bridgeError', { message: String(err) });
                this.d.onEvent('bridge-error', { message: String(err) });
                this.child = null;
            });
            child.on('exit', (code, signal) => {
                (0, logger_1.log)('game.bridgeExit', { code, signal, reason: this.lastReason });
                this.child = null;
                // ⚠️ 关键：探针**每次连不上或断开都会干净退出**（exit 0）。
                //    不自动重启的话，服务端没起 / 中途重启 / 网络抖一下，
                //    桥就永久死了 —— 用户只看到"子进程退出"然后干等，以为坏了。
                //    所以：非主动停止就按退避重启。
                if (this.stopping) {
                    this.d.onEvent('bridge-exit', { code, signal });
                    return;
                }
                this.restarts++;
                // 退避：连续失败拉长间隔，封顶 60 秒，免得刷屏和空转
                const delay = Math.min(60000, 3000 * Math.min(this.restarts, 20));
                this.d.onEvent('bridge-retry', {
                    code,
                    signal,
                    reason: this.lastReason,
                    attempt: this.restarts,
                    retryInMs: delay
                });
                this.retryTimer = setTimeout(() => {
                    this.retryTimer = null;
                    (0, logger_1.log)('game.bridgeRetry', { attempt: this.restarts });
                    this.start();
                }, delay);
            });
        }
        catch (err) {
            // 沙箱/权限问题会让 spawn 直接抛（比如命名管道被拦）—— 不能让桌宠跟着挂
            (0, logger_1.log)('game.bridgeSpawnFail', { message: String(err) });
            this.d.onEvent('bridge-error', { message: String(err) });
            this.child = null;
        }
    }
    stop() {
        // stopping=true 很重要：不设的话退出程序时子进程被杀会触发重启，
        // 桌宠都关了还在拉新进程。
        this.stopping = true;
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        if (!this.child)
            return;
        try {
            this.child.kill();
        }
        catch {
            /* 忽略 */
        }
        this.child = null;
    }
    /**
     * 喂一段 stdout 文本，按行切 JSONL 并派发。
     *
     * **刻意是 public**：它是这个模块里唯一有逻辑的部分，
     * 而 spawn 在 DSH 沙箱里会 EPERM（命名管道被拦），没法端到端测。
     * 所以把解析单独暴露出来，用假的 chunk 序列验证 ——
     * 包括「一行被切成两个 chunk」这种最容易出错的情况。
     *
     * 跨 chunk 的半行必须缓冲住，这和不 SSE 解析是同一个坑。
     */
    feed(chunk) {
        this.buf += chunk;
        let nl;
        while ((nl = this.buf.indexOf('\n')) >= 0) {
            const line = this.buf.slice(0, nl).trim();
            this.buf = this.buf.slice(nl + 1);
            if (!line)
                continue;
            let obj;
            try {
                obj = JSON.parse(line);
            }
            catch {
                // 半行 / 非 JSON 输出，跳过而不是崩
                continue;
            }
            const kind = String(obj.kind ?? '');
            if (kind === 'state') {
                // 连上并拿到状态 = 这一轮重启成功，重置退避计数
                this.restarts = 0;
                this.last = obj;
                this.d.onState(this.last);
            }
            else if (kind === 'end') {
                // 记下断开原因，重连时告诉用户到底为什么（ECONNREFUSED / 被踢 / …）
                this.lastReason = String(obj.reason ?? '连接结束');
                this.d.onEvent(kind, obj);
            }
            else if (kind === 'kicked') {
                this.lastReason = String(obj.reason ?? '被踢出');
                this.d.onEvent(kind, obj);
            }
            else if (kind === 'error') {
                this.lastReason = String(obj.message ?? '未知错误');
                this.d.onEvent(kind, obj);
            }
            else if (kind !== 'hello' && kind !== 'warn') {
                this.d.onEvent(kind, obj);
            }
        }
    }
}
exports.GameBridge = GameBridge;
