// 把 client.js 里的纯逻辑（顺序表相关函数）原样抽出来跑一遍，
// 验证老数据迁移、补全、以及"把某条挪到某条前后"的下标算法。
// 只测纯函数，不碰 DOM/React。
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8').split('\n');
// 常量 + 纯函数区：从 SYS 常量切到「持久化」分隔注释，按标记找，行号变了也不会切歪
const start = src.findIndex((line) => line.indexOf("const SYS = 'sys:'") !== -1);
const end = src.findIndex((line) => line.indexOf('持久化') !== -1);
if (start === -1 || end === -1 || end <= start) throw new Error('切不出纯函数区，标记变了？');
const block = src.slice(start, end).join('\n');

const harness = `
${block}
module.exports = { sysKey, mineKey, isSys, isMine, sysLabel, mineId, normalizeState, legacyLayout, resolveLayout, completeLayout, sameLayout, hiddenOf, completeHidden, normalizeHidden, hiddenMap };
`;
const mod = { exports: {} };
new Function('module', 'exports', harness)(mod, mod.exports);
const L = mod.exports;

let failures = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures += 1;
    console.log('FAIL ' + name + '\n  actual   = ' + a + '\n  expected = ' + e);
  } else {
    console.log('ok   ' + name);
  }
}

const SYSROWS = ['插件', '任务'];

// 1. 全新安装：只有系统行，顺序跟系统一致
check('fresh', L.resolveLayout(L.normalizeState(null), SYSROWS), ['sys:插件', 'sys:任务']);

// 2. 老格式 v3：{items:[{id,anchor}]}
const v3 = { items: [{ id: 'skills', anchor: 'top' }, { id: 'models', anchor: 'after:任务' }] };
const s3 = L.normalizeState(v3);
check('v3 legacy parse', s3.legacy, [
  { id: 'skills', anchor: 'top' },
  { id: 'models', anchor: 'after:任务' }
]);
check('v3 layout', L.resolveLayout(s3, SYSROWS), ['mine:skills', 'sys:插件', 'sys:任务', 'mine:models']);

// 3. 更老的 {order, position}
const v2 = { order: ['models'], position: 'top' };
check('v2 layout', L.resolveLayout(L.normalizeState(v2), SYSROWS), ['mine:models', 'sys:插件', 'sys:任务']);

// 4. 纯 id 数组
check('array layout', L.resolveLayout(L.normalizeState(['skills']), SYSROWS), ['sys:插件', 'sys:任务', 'mine:skills']);

// 5. 锚点指向已消失的系统行：兜底放最后
const orphan = { items: [{ id: 'skills', anchor: 'after:不存在的行' }] };
check('orphan anchor', L.resolveLayout(L.normalizeState(orphan), SYSROWS), ['sys:插件', 'sys:任务', 'mine:skills']);

// 6. 新格式直接生效，并且补上后冒出来的系统行
const v4 = { layout: ['sys:任务', 'mine:skills', 'sys:插件'] };
check('v4 kept', L.resolveLayout(L.normalizeState(v4), SYSROWS), ['sys:任务', 'mine:skills', 'sys:插件']);
check(
  'new system row appended',
  L.completeLayout(['sys:任务', 'mine:skills', 'sys:插件'], ['插件', '任务', '新面板'], () => true),
  ['sys:任务', 'mine:skills', 'sys:插件', 'sys:新面板']
);

// 7. 分区被卸载：入口从表里消失
check(
  'dead section dropped',
  L.completeLayout(['sys:插件', 'mine:gone', 'sys:任务'], SYSROWS, (id) => id !== 'gone'),
  ['sys:插件', 'sys:任务']
);

// 8. 去重
check(
  'dedupe',
  L.completeLayout(['sys:插件', 'sys:插件', 'mine:a', 'mine:a'], SYSROWS, () => true),
  ['sys:插件', 'mine:a', 'sys:任务']
);

// 9. 移动算法（与 moveEntry 同一套下标计算）
function move(layout, sourceKey, targetKey, after) {
  const rest = layout.filter((k) => k !== sourceKey);
  const found = rest.indexOf(targetKey);
  if (found === -1) return null;
  rest.splice(after ? found + 1 : found, 0, sourceKey);
  return rest;
}
const base = ['sys:插件', 'sys:任务', 'mine:a', 'mine:b'];

// 系统行往下拖：插件 放到 任务 后面
check('sys down', move(base, 'sys:插件', 'sys:任务', true), ['sys:任务', 'sys:插件', 'mine:a', 'mine:b']);
// 系统行往上拖：任务 放到 插件 前面
check('sys up', move(base, 'sys:任务', 'sys:插件', false), ['sys:任务', 'sys:插件', 'mine:a', 'mine:b']);
// 我的行插到两行系统之间
check('mine between', move(base, 'mine:a', 'sys:任务', true), ['sys:插件', 'sys:任务', 'mine:a', 'mine:b']);
// 我的行提到最前
check('mine first', move(base, 'mine:b', 'sys:插件', false), ['mine:b', 'sys:插件', 'sys:任务', 'mine:a']);
// 往后拖到自己原来的位置后面（幂等边界）
check('noop-ish', move(base, 'sys:插件', 'sys:插件', true), null);

// 10. 折叠开关跟顺序表存在同一份数据里
check('collapsed 默认关', L.normalizeState({ layout: ['sys:插件'] }).collapsed, false);
check('collapsed 读回来', L.normalizeState({ layout: ['sys:插件'], collapsed: true }).collapsed, true);
check('collapsed 只认布尔真', L.normalizeState({ layout: [], collapsed: 'yes' }).collapsed, false);
check('老数据默认不折叠', L.normalizeState({ items: [{ id: 'skills', anchor: 'top' }] }).collapsed, false);

// 11. 隐藏表：系统自带的行也能藏（藏的是显示，顺序表里那条留着）
check('hidden 默认空', L.normalizeState({ layout: ['sys:插件'] }).hidden, []);
check('hidden 读回来', L.normalizeState({ layout: ['sys:插件'], hidden: ['sys:插件'] }).hidden, ['sys:插件']);
check('hidden 只收系统行', L.normalizeState({ layout: [], hidden: ['mine:a', 'sys:任务', 'sys:任务'] }).hidden, ['sys:任务']);
check('老格式也能带 hidden', L.normalizeState({ items: [], hidden: ['sys:任务'] }).hidden, ['sys:任务']);
check('hiddenOf 兜空', L.hiddenOf(null), []);
// 侧边栏还没渲染时不许修剪——否则刚启动就把用户藏好的行全放出来
check('还没渲染时原样保留', L.completeHidden(['sys:插件', 'sys:任务'], []), ['sys:插件', 'sys:任务']);
check('已经不在的行被修剪掉', L.completeHidden(['sys:插件', 'sys:已卸载'], SYSROWS), ['sys:插件']);
check('藏起来的行不影响顺序表', L.resolveLayout(L.normalizeState({ layout: ['sys:任务', 'sys:插件'], hidden: ['sys:插件'] }), SYSROWS), ['sys:任务', 'sys:插件']);

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILED');
process.exit(failures === 0 ? 0 : 1);
