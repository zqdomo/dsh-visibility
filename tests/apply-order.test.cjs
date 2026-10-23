// 从 client.js 里原文抽出 applyOrder，用假 DOM 验它到底给谁发了什么 order。
const fs = require('fs');
const path = require('path');

const lines = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8').split('\n');

/** 按签名找函数，再用花括号配平切出完整源码（不依赖行号，改文件不会失效）。 */
function extract(signature) {
  const start = lines.findIndex((line) => line.indexOf(signature) !== -1);
  if (start === -1) throw new Error('没找到 ' + signature);
  let depth = 0;
  let end = -1;
  for (let i = start; i < lines.length; i += 1) {
    for (const ch of lines[i]) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
    if (depth === 0) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end + 1).join('\n');
}

/** 切一个可能跨行的 `const NAME = ...;` 常量。 */
function extractConst(name) {
  const start = lines.findIndex((line) => line.indexOf('const ' + name + ' =') !== -1);
  if (start === -1) throw new Error('没找到 const ' + name);
  let end = start;
  while (end < lines.length && !lines[end].trim().endsWith(';')) end += 1;
  return lines.slice(start, end + 1).join('\n');
}

const source = extract('function applyOrder(list, layout)');
const collapseSource = extract('function applyCollapse(');
const hiddenSource = extract('function normalizeHidden(');
const hiddenMapSource = extract('function hiddenMap(');
const autoCollapseSource = extract('function shouldAutoCollapse(');
const clickTargetsSource = extractConst('CLICK_TARGETS');

const harness = `
const MARK = 'data-dsh-sidebar-links';
const SYS = 'sys:';
function sysKey(label) { return SYS + label; }
function isSys(key) { return typeof key === 'string' && key.indexOf(SYS) === 0; }
${clickTargetsSource}
${hiddenSource}
${hiddenMapSource}
${source}
${collapseSource}
${autoCollapseSource}
module.exports = { applyOrder, applyCollapse, normalizeHidden, hiddenMap, shouldAutoCollapse, CLICK_TARGETS };
`;
const mod = { exports: {} };
new Function('module', 'exports', harness)(mod, mod.exports);
const { applyOrder, applyCollapse, normalizeHidden, hiddenMap, shouldAutoCollapse, CLICK_TARGETS } = mod.exports;

// ---- 假 DOM：只实现 applyOrder 用到的那几个成员 ----
function row(label) {
  return {
    attrs: { 'aria-label': label },
    style: {},
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    matches(selector) {
      return selector === 'button[class*="_panelRow"]';
    }
  };
}
// 本插件的行：跟系统行同构，直接是列表的子元素（0.4.1 起不再套 div）
function mineRow(key) {
  return {
    attrs: { 'data-dsh-sidebar-links': 'row', 'data-key': key },
    style: {},
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    matches(selector) {
      return selector === 'button[class*="_panelRow"]';
    }
  };
}

let failures = 0;
function check(name, children, layout, expected) {
  const list = { children };
  applyOrder(list, layout);
  const actual = children.map((child) => child.style.order);
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures += 1;
    console.log('FAIL ' + name + '\n  actual   = ' + a + '\n  expected = ' + e);
  } else {
    console.log('ok   ' + name + ' → ' + a);
  }
}

// 1. 系统行被排到后面，我的行插在中间
check(
  'sys 换位 + mine 插中间',
  [row('插件'), row('任务'), mineRow('mine:a')],
  ['sys:任务', 'mine:a', 'sys:插件'],
  ['2', '0', '1']
);

// 2. 默认顺序（系统行原样，我的行在最后）
check(
  '默认顺序',
  [row('插件'), row('任务'), mineRow('mine:a'), mineRow('mine:b')],
  ['sys:插件', 'sys:任务', 'mine:a', 'mine:b'],
  ['0', '1', '2', '3']
);

// 3. 顺序表里没登记的系统行（比如刚装的插件新加的面板）排到最后，且互相保持 DOM 顺序
check(
  '未登记的系统行兜底',
  [row('插件'), row('任务'), row('新面板'), row('另一个')],
  ['sys:任务', 'sys:插件'],
  ['1', '0', '2', '3']
);

// 4. 顺序表里有、但这一行已经不在 DOM 里的键不影响别人
check(
  '表里有 DOM 里没有的键',
  [row('任务'), mineRow('mine:a')],
  ['sys:插件', 'sys:任务', 'mine:a'],
  ['1', '2']
);

// ---- 折叠：只藏行，标题行永远留着（它是展开的唯一入口）----
function header() {
  return {
    attrs: { 'data-dsh-sidebar-links': 'panel-header' },
    style: {},
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    matches() {
      return false;
    }
  };
}

function checkCollapse(name, build, collapsed, rail, hidden, expectedDisplay, expectedIndent) {
  const children = build();
  for (const child of children) child.style.display = 'before';
  applyCollapse({ children }, collapsed, rail, hidden);
  const display = JSON.stringify(children.map((child) => child.style.display));
  const indent = JSON.stringify(children.map((child) => child.style.paddingLeft));
  const d = JSON.stringify(expectedDisplay);
  const i = JSON.stringify(expectedIndent);
  if (display !== d || indent !== i) {
    failures += 1;
    console.log('FAIL ' + name + '\n  display  = ' + display + ' 期望 ' + d + '\n  indent   = ' + indent + ' 期望 ' + i);
  } else {
    console.log('ok   ' + name + ' → ' + display + ' / ' + indent);
  }
}

const collapseTree = () => [header(), row('插件'), mineRow('mine:a'), row('任务')];

checkCollapse(
  '收起：行全藏，标题留着',
  collapseTree,
  true,
  false,
  [],
  ['before', 'none', 'none', 'none'],
  [undefined, '30px', '30px', '30px']
);
checkCollapse(
  '展开：行全回来，标题没动过',
  collapseTree,
  false,
  false,
  [],
  ['before', '', '', ''],
  [undefined, '30px', '30px', '30px']
);
checkCollapse(
  '窄条模式：不缩进，图标才塞得进 36px',
  collapseTree,
  false,
  true,
  [],
  ['before', '', '', ''],
  [undefined, '', '', '']
);
// 单独藏起来的系统行：展开状态下也只它自己不显示，邻居不受牵连
checkCollapse(
  '只藏「任务」这一行',
  collapseTree,
  false,
  false,
  ['sys:任务'],
  ['before', '', '', 'none'],
  [undefined, '30px', '30px', '30px']
);
// 两种「藏」叠加：整组收起时，被单独藏的行不会因为展开而冒出来
checkCollapse(
  '整组收起 + 单独藏，展开放回来后仍只剩「插件」',
  () => [header(), row('插件'), mineRow('mine:a'), row('任务')],
  false,
  false,
  ['sys:任务'],
  ['before', '', '', 'none'],
  [undefined, '30px', '30px', '30px']
);

// ---- 隐藏表：只收系统行，本插件的键塞进去也没用（它的「藏」是离开顺序表）----
function checkHidden(name, input, expected) {
  const actual = JSON.stringify(normalizeHidden(input));
  const e = JSON.stringify(expected);
  if (actual !== e) {
    failures += 1;
    console.log('FAIL ' + name + '\n  actual   = ' + actual + '\n  expected = ' + e);
  } else {
    console.log('ok   ' + name + ' → ' + actual);
  }
}

checkHidden('只留 sys: 键', ['sys:插件', 'mine:a', 42, '', null], ['sys:插件']);
checkHidden('去重', ['sys:插件', 'sys:插件'], ['sys:插件']);
checkHidden('非数组当空', undefined, []);
checkHidden('查表', ['sys:插件'], ['sys:插件']);
console.log('ok   hiddenMap → ' + JSON.stringify(hiddenMap(['sys:插件'])));

// ---- 点别处自动收起：只认真正的控件，点空白/选文字不动 ----
function fakeTarget(clickable) {
  return {
    closest(selector) {
      return clickable && selector === CLICK_TARGETS ? { tag: 'button' } : null;
    }
  };
}

function fakeHeader(child) {
  return {
    contains(node) {
      return node === child;
    }
  };
}

function checkAuto(name, target, header, collapsed, expected) {
  const actual = shouldAutoCollapse(target, header, collapsed);
  if (actual !== expected) {
    failures += 1;
    console.log('FAIL ' + name + '  实际 ' + actual + ' 期望 ' + expected);
  } else {
    console.log('ok   ' + name + ' → ' + actual);
  }
}

const plainHeader = fakeHeader(null);
checkAuto('已经收着：不动', fakeTarget(true), plainHeader, true, false);
checkAuto('点按钮：收起', fakeTarget(true), plainHeader, false, true);
checkAuto('点空白：不动', fakeTarget(false), plainHeader, false, false);
checkAuto('target 是空：不动', null, plainHeader, false, false);

const headerChild = { tag: 'span' };
const liveHeader = fakeHeader(headerChild);
checkAuto('点标题行自己：交给它管开关', headerChild, liveHeader, false, false);
checkAuto('标题行之外的按钮：照收', fakeTarget(true), liveHeader, false, true);

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILED');
process.exit(failures === 0 ? 0 : 1);
