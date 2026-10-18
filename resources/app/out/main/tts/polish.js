"use strict";
/**
 * TTS 文本「演戏」——把一句话改成更适合"慢、疲惫、平静"的语气。
 *
 * 规则与 `tools/tts_polish.py` **逐条对齐**（那个版本给脚本/试听用，这个是线上用的）。
 * ⚠️ 两份实现必须同结果：`tools/verify-tts.mjs` 里存了**黄金值**（从 Python 版生成），
 *    TS 版跑同样语料必须完全一致 —— 否则就是"试听好听、上线变味"。
 *
 * 为什么需要：edge-tts 只有 rate/pitch 两个旋钮，压不住"元气感"；
 * 剩下的只能靠**标点制造停顿**（短句句号→省略号、长句插逗号、感叹号降级）。
 * 注意别过度：插太多逗号会变成"念单词"，所以有 maxInserts 上限。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.polish = polish;
exports.prepareForTts = prepareForTts;
/** 句首语气词：后面补省略号，像叹气起头 */
const INTERJECTIONS = ['唉呀', '唉', '啊', '嗯', '唔', '哦', '哎'];
/** 插逗号时优先放在这些词**之前**（前面已是完整小意群） */
const SOFT_HEAD = ['然后', '在', '就', '都', '又', '陪', '把', '给', '让', '和', '跟', '可'];
/**
 * 插逗号时优先放在这些词**之后** —— 只保留多音节词。
 * ⚠️ 别放 `了`/`的`：会把"想了|很久"切成"想了，很久"，读起来像断气（实测踩过）。
 */
const SOFT_TAIL = ['的时候', '时候', '之后', '以后'];
const SENT_END = '。！？!?…';
const CLAUSE_END = '，,、；;：:';
function normalize(text) {
    let t = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    t = t.replace(/[！!]/g, '。');
    t = t.replace(/,/g, '，');
    t = t.replace(/[ \t]+/g, ' ');
    t = t.replace(/，{2,}/g, '，');
    t = t.replace(/。{2,}/g, '。');
    t = t.replace(/…{3,}/g, '……');
    t = t.replace(/。…|…。/g, '……');
    t = t.replace(/\n{3,}/g, '\n\n');
    return t.trim();
}
function splitKeep(s) {
    const out = [];
    let buf = '';
    for (const ch of s) {
        buf += ch;
        if (SENT_END.includes(ch) || CLAUSE_END.includes(ch)) {
            out.push(buf);
            buf = '';
        }
    }
    if (buf)
        out.push(buf);
    return out;
}
function bodyAndTail(seg) {
    let end = seg.length;
    while (end > 0) {
        const ch = seg[end - 1];
        if (SENT_END.includes(ch) || CLAUSE_END.includes(ch))
            end--;
        else
            break;
    }
    return { body: seg.slice(0, end), tail: seg.slice(end) };
}
function shortToEllipsis(seg, maxLen = 6) {
    const { body, tail } = bodyAndTail(seg);
    if (body.length <= maxLen && tail.endsWith('。') && !/[，、]$/.test(body)) {
        return body + '……';
    }
    return seg;
}
function insertComma(seg, minLen = 9) {
    const { body, tail } = bodyAndTail(seg);
    if (body.includes('，') || body.length < minLen)
        return seg;
    // 已经是逗号收尾 ⇒ 这里本来就是停顿点，别再插
    if (tail.startsWith('，'))
        return seg;
    const midStart = Math.max(2, Math.floor(body.length * 0.45));
    const midEnd = Math.max(midStart + 1, Math.floor(body.length * 0.8));
    for (let i = midStart; i < Math.min(midEnd, body.length); i++) {
        if (i < 3 || body.length - i < 3)
            continue;
        for (const h of SOFT_HEAD) {
            if (body.startsWith(h, i))
                return body.slice(0, i) + '，' + body.slice(i) + tail;
        }
    }
    for (let i = midStart; i < Math.min(midEnd, body.length); i++) {
        if (i < 3 || body.length - i < 3)
            continue;
        for (const w of SOFT_TAIL) {
            if (body.slice(0, i + 1).endsWith(w)) {
                return body.slice(0, i + 1) + '，' + body.slice(i + 1) + tail;
            }
        }
    }
    return seg;
}
function interjectionEllipsis(seg) {
    for (const w of INTERJECTIONS) {
        if (seg.startsWith(w)) {
            const rest = seg.slice(w.length);
            if (rest && !/^[…，。、]/.test(rest))
                return w + '……' + rest;
            break;
        }
    }
    return seg;
}
function polish(text, o = {}) {
    // `polish: false` = 只做规范化，不改写标点。
    // 为什么需要：GPT-SoVITS 自己的韵律已经很好，而"短句→省略号"会让它拉出很长的停顿
    //（实测同一句：润色 11.37s / 不润色 7.51s，用户听感是"中间慢出电音"）。
    if (o.polish === false)
        return normalize(text);
    const ruleShort = o.ruleShort !== false;
    const ruleComma = o.ruleComma !== false;
    const ruleInterjection = o.ruleInterjection !== false;
    const maxInserts = o.maxInserts ?? 4;
    const segs = splitKeep(normalize(text));
    const out = [];
    let inserted = 0;
    for (const seg of segs) {
        let s = seg;
        if (ruleInterjection)
            s = interjectionEllipsis(s);
        if (ruleComma && inserted < maxInserts) {
            const before = s;
            s = insertComma(s);
            if (s !== before)
                inserted++;
        }
        if (ruleShort)
            s = shortToEllipsis(s);
        out.push(s);
    }
    return normalize(out.join(''));
}
/** 给 TTS 用的最终文本：润色 + 长度上限（超了按句切，别让一条太长） */
function prepareForTts(text, opts = {}) {
    const max = opts.maxChars ?? 120;
    let t = polish(text, opts);
    if (t.length > max) {
        // 在 max 附近找最后一个句末标点；找不到就硬截
        const head = t.slice(0, max);
        const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('…'), head.lastIndexOf('？'));
        t = cut > max * 0.5 ? head.slice(0, cut + 1) : head;
    }
    return t.trim();
}
