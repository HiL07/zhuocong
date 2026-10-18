"use strict";
/**
 * 人格（system prompt）的组装：占位符替换 + 状态注入。
 *
 * 为什么单独一个文件：
 *   · 设置窗要能"试说一句"并显示**实际发出的** system prompt —— 逻辑必须与真实发送路径**同一份**；
 *   · 占位符**不在保存时替换**（用户改了名字不该回头改他的提示词），只在发请求前替换；
 *   · 状态注入要追加在**末尾独立段落**，不能插进用户粘贴的角色卡正文里。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PET_STATES = void 0;
exports.buildSystemPrompt = buildSystemPrompt;
exports.stateSectionPreview = stateSectionPreview;
/** 这些状态名会让模型"按状态说话"，与 8 个动画状态一一对应 */
exports.PET_STATES = ['idle', 'click', 'held', 'talking', 'thinking', 'error', 'running', 'rolling'];
/**
 * 把人格文本 + 占位符 + 状态拼成最终 system prompt。
 * 纯函数，便于单测与"试说一句"预览（两端必须一致）。
 */
function buildSystemPrompt(o) {
    let text = (o.personality ?? '').trim();
    // 占位符替换（大小写/全角括号都兼容一下，用户可能从别处粘过来）
    const pairs = [
        ['[桌宠名字]', o.name || '鲸鱼娘'],
        ['【桌宠名字】', o.name || '鲸鱼娘'],
        ['[你的称呼]', o.userName || '你'],
        ['【你的称呼】', o.userName || '你']
    ];
    for (const [ph, val] of pairs) {
        text = text.split(ph).join(val);
    }
    if (!o.stateInjection)
        return text;
    // 状态段落：独立、可被模型忽略（放在最后，不打断用户正文）
    const state = o.state ?? 'idle';
    const section = [`【当前状态：${state}】`].join('\n');
    return text ? text + '\n\n' + section : section;
}
/** 状态注入段落示例（设置窗用来展示"会被追加什么"） */
function stateSectionPreview(state = 'held') {
    return `【当前状态：${state}】`;
}
