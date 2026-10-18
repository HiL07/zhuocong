"use strict";
/**
 * 骰子判定（跑团味儿的核心工具）。
 *
 * 为什么单独抽出来：判定会在每个节点反复用到，而"怎么算、怎么显示"
 * 必须全游戏统一（不然有的地方写 `2d6+3≥9`、有的写 `1d20`，玩家会乱）。
 * 引擎拿到 `DiceRoll` 后**不需要自己拼文字** —— 宿主会用同一个组件显示骰面。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.check = check;
exports.describe = describe;
/** 掷一次并（可选）判定。失败不会抛错 —— 判定本身永远"成功执行"。 */
function check(ctx, o = {}) {
    const count = Math.max(1, o.count ?? 2);
    const sides = Math.max(2, o.sides ?? 6);
    const modifier = o.modifier ?? 0;
    const rolls = ctx.rng.roll(sides, count);
    const total = rolls.reduce((a, b) => a + b, 0) + modifier;
    const expr = `${o.label ? o.label + ' ' : ''}${count}d${sides}${modifier >= 0 ? '+' + modifier : modifier}`;
    const roll = { expr, rolls, modifier, total };
    if (typeof o.dc === 'number') {
        roll.dc = o.dc;
        roll.success = total >= o.dc;
    }
    ctx.log(`[dice] ${expr} → ${rolls.join('+')}${modifier ? (modifier > 0 ? '+' + modifier : modifier) : ''} = ${total}${roll.dc ? ` vs ${roll.dc} → ${roll.success ? '成功' : '失败'}` : ''}`);
    return roll;
}
/** 把骰面写成一句人话（给不需要精细排版的场合用） */
function describe(roll) {
    const base = roll.rolls.join(' + ');
    const mod = roll.modifier ? (roll.modifier > 0 ? ` + ${roll.modifier}` : ` - ${Math.abs(roll.modifier)}`) : '';
    const dc = roll.dc !== undefined ? `（难度 ${roll.dc}：${roll.success ? '成功' : '失败'}）` : '';
    return `${roll.expr}：${base}${mod} = ${roll.total}${dc}`;
}
