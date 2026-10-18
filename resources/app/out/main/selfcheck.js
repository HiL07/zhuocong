"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runSelfcheck = runSelfcheck;
const electron_1 = require("electron");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const config_1 = require("./config");
const logger_1 = require("./logger");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 统计整张图的 alpha 分布 —— 直接回答"页面是否真透明" */
function alphaStats(img) {
    const bmp = img.toBitmap();
    const { width, height } = img.getSize();
    const total = width * height;
    let transparent = 0;
    let opaque = 0;
    let blackOpaque = 0;
    for (let i = 0; i < total; i++) {
        const o = i * 4;
        const a = bmp[o + 3];
        if (a === 0) {
            transparent++;
        }
        else {
            opaque++;
            if (bmp[o] === 0 && bmp[o + 1] === 0 && bmp[o + 2] === 0 && a === 255)
                blackOpaque++;
        }
    }
    return {
        width,
        height,
        total,
        transparent,
        opaque,
        blackOpaque,
        transparentPct: Number(((transparent / total) * 100).toFixed(2)),
        blackOpaquePct: Number(((blackOpaque / total) * 100).toFixed(2))
    };
}
/** 取一块区域的平均颜色（用于整屏截图里的窗口内外对比） */
function regionAvg(img, rx, ry, rw, rh) {
    const bmp = img.toBitmap();
    const { width, height } = img.getSize();
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    let n = 0;
    for (let y = ry; y < ry + rh; y++) {
        for (let x = rx; x < rx + rw; x++) {
            if (x < 0 || y < 0 || x >= width || y >= height)
                continue;
            const o = (y * width + x) * 4;
            b += bmp[o];
            g += bmp[o + 1];
            r += bmp[o + 2];
            a += bmp[o + 3];
            n++;
        }
    }
    if (n === 0)
        return { r: 0, g: 0, b: 0, a: 0 };
    return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n), a: Math.round(a / n) };
}
function cleanup(outDir, keepLastN) {
    try {
        const files = (0, node_fs_1.readdirSync)(outDir)
            .map((f) => ({ f, t: (0, node_fs_1.statSync)((0, node_path_1.join)(outDir, f)).mtimeMs }))
            .sort((a, b) => b.t - a.t);
        const doomed = files.slice(keepLastN);
        for (const d of doomed)
            (0, node_fs_1.rmSync)((0, node_path_1.join)(outDir, d.f), { force: true });
        return doomed.length;
    }
    catch {
        return 0;
    }
}
async function runSelfcheck(win, cfg, profile) {
    const outDir = (0, node_path_1.join)((0, config_1.projectRoot)(), '.selfcheck', 'shots');
    (0, node_fs_1.mkdirSync)(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const base = `${stamp}-p${profile}`;
    const files = {};
    win.show();
    win.moveTop();
    await sleep(cfg.selfcheck.settleMs);
    // 1) 渲染层原样截图（是否带真 alpha）
    const rawImg = await win.webContents.capturePage();
    files.raw = (0, node_path_1.join)(outDir, `${base}-raw.png`);
    (0, node_fs_1.writeFileSync)(files.raw, rawImg.toPNG());
    const rawAlpha = alphaStats(rawImg);
    // 2) 调试背景版：铺不透明棋盘格，供人眼/程序区分"真透明"与"PNG 透明区显示为黑"
    await win.webContents.executeJavaScript("document.body.classList.add('debug-bg')");
    await sleep(400);
    const bgImg = await win.webContents.capturePage();
    files.bg = (0, node_path_1.join)(outDir, `${base}-bg.png`);
    (0, node_fs_1.writeFileSync)(files.bg, bgImg.toPNG());
    await win.webContents.executeJavaScript("document.body.classList.remove('debug-bg')");
    // 3) 整屏截图：判定桌面上是否真的合成出黑底
    const disp = electron_1.screen.getPrimaryDisplay();
    const sf = disp.scaleFactor;
    let desktopProbe = { skipped: true };
    try {
        const sources = await electron_1.desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: {
                width: Math.round(disp.size.width * sf),
                height: Math.round(disp.size.height * sf)
            }
        });
        const src = sources.find((s) => s.display_id === String(disp.id)) ?? sources[0];
        if (src) {
            files.desktop = (0, node_path_1.join)(outDir, `${base}-desktop.png`);
            (0, node_fs_1.writeFileSync)(files.desktop, src.thumbnail.toPNG());
            const b = win.getBounds();
            const rect = {
                x: Math.round(b.x * sf),
                y: Math.round(b.y * sf),
                w: Math.round(b.width * sf),
                h: Math.round(b.height * sf)
            };
            const P = 10; // 探针方块边长
            const inset = 14; // 从窗口边缘往里缩进，避开角色本体
            const insideTL = regionAvg(src.thumbnail, rect.x + inset, rect.y + inset, P, P);
            const insideTR = regionAvg(src.thumbnail, rect.x + rect.w - inset - P, rect.y + inset, P, P);
            const insideBL = regionAvg(src.thumbnail, rect.x + inset, rect.y + rect.h - inset - P, P, P);
            const insideBR = regionAvg(src.thumbnail, rect.x + rect.w - inset - P, rect.y + rect.h - inset - P, P, P);
            // 窗口左外侧同高度的一条带作为桌面基准
            const outside = regionAvg(src.thumbnail, Math.max(0, rect.x - 40), rect.y + Math.round(rect.h / 2) - 20, 24, 40);
            const avg = (arr) => ({
                r: Math.round(arr.reduce((s, v) => s + v.r, 0) / arr.length),
                g: Math.round(arr.reduce((s, v) => s + v.g, 0) / arr.length),
                b: Math.round(arr.reduce((s, v) => s + v.b, 0) / arr.length),
                a: Math.round(arr.reduce((s, v) => s + v.a, 0) / arr.length)
            });
            const inside = avg([insideTL, insideTR, insideBL, insideBR]);
            const dist = Math.round(Math.sqrt((inside.r - outside.r) ** 2 + (inside.g - outside.g) ** 2 + (inside.b - outside.b) ** 2));
            const looksBlackBox = inside.r <= 12 && inside.g <= 12 && inside.b <= 12 && dist > 30;
            desktopProbe = {
                skipped: false,
                scaleFactor: sf,
                windowRectPhysical: rect,
                corners: { insideTL, insideTR, insideBL, insideBR },
                insideAvg: inside,
                outsideAvg: outside,
                colorDistance: dist,
                verdict: looksBlackBox
                    ? 'BLACK_BOX_SUSPECTED'
                    : dist <= 30
                        ? 'TRANSPARENT_OK'
                        : 'INCONCLUSIVE'
            };
        }
    }
    catch (e) {
        desktopProbe = { skipped: true, error: String(e) };
    }
    const report = {
        ts: new Date().toISOString(),
        profile,
        files,
        bounds: win.getBounds(),
        isAlwaysOnTop: win.isAlwaysOnTop(),
        isVisible: win.isVisible(),
        display: {
            id: disp.id,
            size: disp.size,
            workArea: disp.workArea,
            scaleFactor: sf,
            colorDepth: disp.colorDepth
        },
        pageAlpha: rawAlpha,
        desktopProbe,
        gpu: electron_1.app.getGPUFeatureStatus(),
        gpuAccelerationDisabled: profile === 'C',
        transparentVisualsSwitch: profile === 'B' || profile === 'C',
        versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node }
    };
    const reportPath = (0, node_path_1.join)(outDir, `${base}-report.json`);
    (0, node_fs_1.writeFileSync)(reportPath, JSON.stringify(report, null, 2), 'utf8');
    (0, logger_1.log)('selfcheck.done', { reportPath, profile, pageAlpha: rawAlpha, desktopProbe });
    const removed = cleanup(outDir, cfg.selfcheck.keepLastN);
    if (removed > 0)
        (0, logger_1.log)('selfcheck.cleanup', { removed, keepLastN: cfg.selfcheck.keepLastN });
    // eslint-disable-next-line no-console
    console.log('SELFCHECK_REPORT_PATH=' + reportPath);
    return report;
}
