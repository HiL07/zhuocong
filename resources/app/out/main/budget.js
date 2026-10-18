"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Budget = void 0;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const ZERO = { month: '', inTokens: 0, outTokens: 0, cachedTokens: 0 };
class Budget {
    usage;
    file;
    limitCNY;
    degradeRatio;
    tokensPerCNY;
    /**
     * @param opts.root 工作根目录（用量文件写到 `<root>/.local/usage.json`）。
     *
     * 为什么 `root` 是参数而不再从 `./config` 引入 `projectRoot()`：
     *   `config.ts` 依赖 electron 的 `app.getAppPath()`，一旦 import 进来，
     *   这个类就**无法在命令行里验证**。改成注入之后，
     *   `Budget` 和 `src/providers/` 一样是纯 Node 模块，
     *   可以被 `tools/verify-budget.mjs` 直接测。
     */
    constructor(opts) {
        this.limitCNY = opts.monthlyLimitCNY;
        this.degradeRatio = opts.degradeAtRatio;
        this.tokensPerCNY = opts.tokensPerCNY;
        const dir = (0, node_path_1.join)(opts.root ?? process.cwd(), '.local');
        (0, node_fs_1.mkdirSync)(dir, { recursive: true });
        this.file = (0, node_path_1.join)(dir, 'usage.json');
        this.usage = this.load();
    }
    /** 用量文件的绝对路径（诊断用） */
    get filePath() {
        return this.file;
    }
    monthKey() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
    load() {
        try {
            if ((0, node_fs_1.existsSync)(this.file)) {
                const u = JSON.parse((0, node_fs_1.readFileSync)(this.file, 'utf8'));
                if (u.month === this.monthKey())
                    return u;
            }
        }
        catch {
            /* 损坏则重置 */
        }
        return { ...ZERO, month: this.monthKey() };
    }
    persist() {
        try {
            (0, node_fs_1.writeFileSync)(this.file, JSON.stringify(this.usage, null, 2), 'utf8');
        }
        catch {
            /* 写失败不影响主流程 */
        }
    }
    /** 已消耗 token 折算成人民币（估算值） */
    spentCNY() {
        const total = this.usage.inTokens + this.usage.outTokens;
        return total / this.tokensPerCNY;
    }
    ratio() {
        return this.limitCNY <= 0 ? 1 : this.spentCNY() / this.limitCNY;
    }
    check() {
        const r = this.ratio();
        if (r >= 1)
            return 'block';
        if (r >= this.degradeRatio)
            return 'degrade';
        return 'ok';
    }
    /** 记录一次真实用量。cached 是缓存命中的输入 token（不计入花费，仅用于统计） */
    record(u) {
        if (this.usage.month !== this.monthKey())
            this.usage = { ...ZERO, month: this.monthKey() };
        this.usage.inTokens += u.in;
        this.usage.outTokens += u.out;
        this.usage.cachedTokens += u.cached ?? 0;
        this.persist();
    }
    snapshot() {
        return { ...this.usage, spentCNY: this.spentCNY(), ratio: this.ratio(), verdict: this.check() };
    }
}
exports.Budget = Budget;
