"use strict";
/**
 * 示例剧本：**节点一「路牌陷阱」的骨架**（可玩，但不是成品剧本）。
 *
 * 它的作用有两个：
 *   1. 当**接口的活体文档** —— 想写自己的章节，照着这个文件抄结构就行；
 *   2. 当**离线验证的被测对象** —— `tools/verify-story.mjs` 拿假 PetDriver 跑它，
 *      断言"选项 / 骰子 / 状态增量 / 结束标记"都对。
 *
 * 剧情对应 `docs/plan-story-interface.md` §4 的节点一：白光落地 → 路牌 → 敏捷卡点 → 康康必杀 → 原石"留痕但不解释"。
 * ⚠️ 数值/文本都是为了演示，正式剧本定稿后替换即可 —— **接口不用改**。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.demoNode1 = exports.DemoNode1 = void 0;
const dice_1 = require("../dice");
class DemoNode1 {
    id = 'demo-node1';
    title = '节点一 · 路牌陷阱（示例骨架）';
    /** 内部阶段，避免玩家乱点把状态打乱 */
    phase = 'sign';
    start(ctx) {
        const agi = ctx.state.get('player.agi', 3);
        this.phase = 'sign';
        ctx.pet.thinking(false);
        ctx.pet.mood('idle');
        ctx.pet.expr('neutral');
        return {
            speaker: '旁白',
            text: '白光散去，你站在一条没有尽头的走廊里，空气是湿冷的。' +
                '墙边歪着一块路牌，箭头指向左边，可箭头下面那行小字被磨得只剩半个"死"字。\n' +
                `（你的敏捷 ${agi}。旁边那只鲸鱼娘——康康——正拽你的衣角。）`,
            mood: 'idle',
            expr: 'neutral',
            choices: [
                { id: 'read', label: '蹲下看清路牌上的字', hint: '谨慎：可能发现陷阱' },
                { id: 'go', label: '不管了，照箭头走', hint: '鲁莽：直接踩过去' },
                { id: 'ask', label: '问康康这是什么地方' },
            ],
            state: { player: { agi } }
        };
    }
    choose(choiceId, ctx) {
        if (this.phase === 'sign') {
            if (choiceId === 'ask') {
                return {
                    speaker: '康康',
                    text: '康康把嘴巴凑到你耳边，声音小得像气泡破了：「路牌是坏的，别信箭头。跟着我。」',
                    mood: 'thinking',
                    expr: 'thinking',
                    exprSecs: 2,
                    choices: [
                        { id: 'read', label: '那就蹲下看看那块牌子' },
                        { id: 'go', label: '还是照箭头走' },
                    ]
                };
            }
            if (choiceId === 'read' || choiceId === 'go') {
                const agi = ctx.state.get('player.agi', 3);
                // 看牌 = 发现了陷阱，难度低；不看 = 直接踩上去，难度高
                const dc = choiceId === 'read' ? 9 : 11;
                const roll = (0, dice_1.check)(ctx, { count: 2, sides: 6, modifier: agi - 3, dc, label: choiceId === 'read' ? '敏捷（看穿陷阱）' : '敏捷（踩中陷阱）' });
                this.phase = 'rolled';
                const ok = roll.success === true;
                return {
                    speaker: '旁白',
                    text: ok
                        ? '你贴着墙根挪过去，靴底避开了那道几乎看不见的细线。身后"咔"的一声，箭矢钉进了另一侧墙里。'
                        : '你才迈出两步，脚下就"咔"的一声轻响——一排箭矢从墙里射出来，你连滚带爬地躲开，膝盖擦破了皮。',
                    mood: ok ? 'talking' : 'error',
                    expr: ok ? 'happy' : 'surprised',
                    exprSecs: 1.6,
                    roll,
                    state: ok ? { bag: { items: ['巧乐兹雪碧'] }, } : { player: { hp: -1 }, },
                    choices: [
                        { id: 'onward', label: ok ? '继续往前，走廊尽头有光' : '咬牙爬起来，继续往前' }
                    ]
                };
            }
        }
        if (choiceId === 'onward') {
            this.phase = 'done';
            return {
                speaker: '旁白',
                text: '走廊尽头有光，也有别的东西。康康先一步跳上你的肩膀，替你挡在前面。\n' +
                    '等一切安静下来，你才发觉：刚才有什么东西滚到了脚边。你下意识捡起来塞进背包，没来得及细看——康康已经在催你走了。',
                mood: 'idle',
                expr: 'neutral',
                // 关键：**不提示、不解释**。原石"留痕但不揭示"（设计 §2.1）
                state: { bag: { yuanShi: { count: 1, noted: true } }, flags: { node1Done: true } },
                end: true
            };
        }
        // 兜底：任何未知选项都不该让玩家卡死
        return { speaker: '旁白', text: '（这里还没写完。）', choices: [{ id: 'onward', label: '继续' }] };
    }
    say(text, ctx) {
        ctx.state.set('log.lastSaid', text);
        if (this.phase === 'sign') {
            return {
                speaker: '康康',
                text: '康康歪着头看你：「你说什么？风太大我没听清。要不……先看看那块牌子？」',
                mood: 'thinking',
                expr: 'thinking',
                exprSecs: 1.4,
                choices: [
                    { id: 'read', label: '蹲下看清路牌上的字' },
                    { id: 'go', label: '照箭头走' }
                ]
            };
        }
        if (this.phase === 'rolled') {
            return { speaker: '旁白', text: '走廊尽头的风越来越冷。该往前了。', choices: [{ id: 'onward', label: '继续往前' }] };
        }
        return { speaker: '旁白', text: '这一节点的故事已经讲完了。（示例骨架到此为止。）', end: true };
    }
}
exports.DemoNode1 = DemoNode1;
exports.demoNode1 = {
    meta: { id: 'demo-node1', title: '节点一 · 路牌陷阱（示例骨架）', desc: '接口演示用，不是成品剧本' },
    create: () => new DemoNode1()
};
