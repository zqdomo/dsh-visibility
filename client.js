/**
 * `@local/dsh-visibility` 的客户端半边：把「设置」里的各个分区做成左侧边栏的直达入口。
 *
 * 点一下侧边栏上的入口，就打开设置弹窗并定位到那个分区。
 *
 * 为什么要绕一圈：
 *   - 设置弹窗的开关状态由 settings-general 包内私有的 `createSettingsShellStore()`
 *     持有，没有对外服务，`settings.open` 命令在 Desktop 上只由原生键盘分发，
 *     合成 KeyboardEvent 无效——所以没有"一行代码打开设置"的 API。
 *   - 也不能自己把分区组件渲染到主区域：`settings.section` 的注册组件会调用
 *     自己的 `renderSlot` 渲染它声明的子 slot（如 `settings.plugins.tab`），
 *     而 `renderSlot` 只发给"声明了 children 的注册项"，借来的组件一渲染就崩。
 *   - 于是只能走真实 UI：账号菜单按钮（`button[aria-haspopup="menu"]`，aria-label
 *     是「账号菜单」）→ 菜单项「设置」（`button[role="menuitem"]`）→ 弹窗
 *     `[data-shortcut-modal="settings"]` 里的 `navCell`。三步都是真实存在的 DOM。
 *
 * 排序模型：侧边栏的每一行——系统自带的「插件」「任务」…和本插件插进去的入口——
 * 在「顺序表」里各占一个键，键在表里的下标就是这一行的 CSS `order`。
 * 谁也不动 DOM 顺序：
 *   - 系统行是 React 按自己的数组渲染的，硬挪 DOM 会在它下一次重渲染时打架；
 *   - 而 `.…_panelList` 是 `display:flex; flex-direction:column`，
 *     `order` 就能把视觉顺序排成任意样子，React 对此一无所知，
 *     也就永远不会把顺序改回去。
 * 拖拽只改这张表：改完落盘，再按表重新分配每行的 `order`。
 *
 * 隐藏模型：系统自带的行（「插件」「任务」…）除了能拖，还能单独藏起来。
 * 藏起来的键记在状态里的 `hidden` 表，**顺序表里那条不动**——位置还记着，
 * 以后点「显示」就回到原来的位置，不会跑到末尾去。
 * 落地手段仍是行内样式：`display:none`。React 只认自己的 props，
 * 不会去清 `style.display`（`order` 和折叠已经这么干了两代了）。
 * 所以 `applyCollapse` 一次算两件事：整组收起（`collapsed`）或这一行被藏（`hidden`），
 * 任一成立就 `display:none`。
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-visibility',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** 存放侧边栏顺序表的键。 */
    const STORAGE_KEY = 'dsh-sidebar-links.v4';
    /** 更早版本的键，仅用于迁移。 */
    const LEGACY_KEYS = ['dsh-sidebar-links.v3', 'dsh-sidebar-links.v2', 'dsh-sidebar-links.sections.v1'];
    /** 本插件自己注册的设置分区 id（列表里要排除自己，免得套娃）。 */
    const SECTION_ID = 'sidebar-links';
    /** 本插件在设置左栏里的名字。 */
    const SECTION_LABEL = '侧边栏入口';
    /** 标记归本插件管的 DOM 节点。 */
    const MARK = 'data-dsh-sidebar-links';
    /** 标记系统行当前的键（界面语言变了要跟着改）。 */
    const DRAG_MARK = 'data-dsh-drag';
    /** 标记系统行已经接过拖拽监听，只设一次。 */
    const DRAG_WIRED = 'data-dsh-drag-wired';
    /**
     * 实例代次。客户端的插件模块被热替换时，旧实例不会被销毁，
     * 它的观察器和行会继续活着、继续抢点击。这里给每次加载发一个递增编号，
     * 编号不是最新的一律自我停摆，保证只有最后加载的那份在干活。
     */
    const GEN = (window.__dshVisibilityGen = (window.__dshVisibilityGen || 0) + 1);
    /** 拖拽时塞进 dataTransfer 的前缀，避免接住别人拖的东西。 */
    const DRAG_PREFIX = 'dsh-sidebar-link:';
    /** 顺序表里的两种键：系统行按标签认，本插件的入口按设置分区 id 认。 */
    const SYS = 'sys:';
    const MINE = 'mine:';

    const ROW_ICON =
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
      '<rect x="2.25" y="2.75" width="11.5" height="10.5" rx="2.25" stroke="currentColor" stroke-width="1.3"/>' +
      '<path d="M2.5 6.25h11" stroke="currentColor" stroke-width="1.3"/>' +
      '</svg>';

    /** 组标题行的图标：三条横线（跟侧边栏里「扩展管理」那一组的样子对齐）。 */
    const MENU_ICON =
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
      '<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h7.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
      '</svg>';

    /** 拖拽落点提示：用内阴影而不是边框，免得行高跳动。 */
    const LINE = 'inset 0 2px 0 0 var(--dsw-alias-label-primary, currentColor)';
    const LINE_BOTTOM = 'inset 0 -2px 0 0 var(--dsw-alias-label-primary, currentColor)';

    // 内存里留一份，避免每次 DOM 变动都去 parse localStorage。
    let memState = null;
    // 侧边栏的行没有 React 状态可用，用一个小变量兜住"正在拖谁"。
    let dragState = null;
    // 当前画着落点提示的那一行。
    let indicator = null;
    // 设置面板订阅顺序表的变化（在侧边栏里拖动时，面板要跟着动）。
    const listeners = new Set();

    // ---------------------------------------------------------------- 顺序表

    function sysKey(label) {
      return SYS + label;
    }

    function mineKey(id) {
      return MINE + id;
    }

    function isSys(key) {
      return typeof key === 'string' && key.indexOf(SYS) === 0;
    }

    function isMine(key) {
      return typeof key === 'string' && key.indexOf(MINE) === 0;
    }

    function sysLabel(key) {
      return key.slice(SYS.length);
    }

    function mineId(key) {
      return key.slice(MINE.length);
    }

    /**
     * 统一成 `{ layout: [key], hidden: [key] }`。
     * 老版本是「每条入口带一个锚点」（`{items:[{id,anchor}]}`，再早是 `{order,position}`
     * 和纯 id 数组）。老数据先原样留在 `legacy` 里，等能读到系统行的顺序时再折算成
     * 顺序表——刚启动那一瞬间侧边栏可能还没渲染，硬折算会把锚点信息丢掉。
     */
    function normalizeState(value) {
      if (value && typeof value === 'object' && Array.isArray(value.layout)) {
        const layout = [];
        for (const key of value.layout) {
          if (typeof key !== 'string' || !key) continue;
          if (layout.indexOf(key) !== -1) continue;
          layout.push(key);
        }
        return {
          layout,
          legacy: null,
          collapsed: value.collapsed === true,
          hidden: normalizeHidden(value.hidden)
        };
      }

      const items = [];
      const push = (id, anchor) => {
        if (typeof id !== 'string' || !id) return;
        if (items.some((item) => item.id === id)) return;
        items.push({ id, anchor: typeof anchor === 'string' && anchor ? anchor : 'bottom' });
      };

      const hidden = normalizeHidden(value && value.hidden);
      if (Array.isArray(value)) {
        for (const id of value) push(id, 'bottom');
        return { layout: null, legacy: items, collapsed: false, hidden };
      }
      if (value && typeof value === 'object') {
        if (Array.isArray(value.items)) {
          for (const item of value.items) {
            if (item && typeof item === 'object') push(item.id, item.anchor);
            else push(item, 'bottom');
          }
          return { layout: null, legacy: items, collapsed: false, hidden };
        }
        if (Array.isArray(value.order)) {
          const anchor = typeof value.position === 'string' && value.position ? value.position : 'bottom';
          for (const id of value.order) push(id, anchor);
          return { layout: null, legacy: items, collapsed: false, hidden };
        }
      }
      return { layout: null, legacy: items, hidden };
    }

    /**
     * 隐藏表：只收系统行的键（`sys:` 开头），去重、丢空。
     * 本插件自己的入口不在这张表里——它的「藏」就是把键从顺序表里拿掉，一回事两种叫法。
     */
    function normalizeHidden(value) {
      const out = [];
      if (!Array.isArray(value)) return out;
      for (const key of value) {
        if (typeof key !== 'string' || !isSys(key)) continue;
        if (out.indexOf(key) !== -1) continue;
        out.push(key);
      }
      return out;
    }

    /** 状态里的隐藏表。 */
    function hiddenOf(state) {
      return normalizeHidden(state && state.hidden);
    }

    /**
     * 修剪隐藏表：只留当前还在渲染的系统行。
     * 侧边栏还没渲染出来（`systemLabels` 是空的）时一律原样保留——
     * 否则刚启动那一瞬间就会把用户藏好的行全放出来。
     */
    function completeHidden(hidden, systemLabels) {
      const list = normalizeHidden(hidden);
      if (!systemLabels || systemLabels.length === 0) return list;
      const alive = Object.create(null);
      for (const label of systemLabels) alive[sysKey(label)] = true;
      return list.filter((key) => alive[key] === true);
    }

    /** 隐藏表转成查表对象：`applyCollapse` 每帧都要问"这行藏没藏"，别用数组 indexOf。 */
    function hiddenMap(hidden) {
      const map = Object.create(null);
      for (const key of normalizeHidden(hidden)) map[key] = true;
      return map;
    }


    /** 把老锚点折算成顺序表：top 打头，`after:<系统行>` 跟在那行后面，bottom 收尾。 */
    function legacyLayout(legacy, systemLabels) {
      const out = [];
      const take = (predicate) => {
        for (const item of legacy) {
          const key = mineKey(item.id);
          if (out.indexOf(key) !== -1) continue;
          if (!predicate(item)) continue;
          out.push(key);
        }
      };
      take((item) => item.anchor === 'top');
      for (const label of systemLabels) {
        out.push(sysKey(label));
        take((item) => item.anchor === 'after:' + label);
      }
      take((item) => item.anchor === 'bottom' || !item.anchor);
      // 锚点指向的系统行已经不在了：兜底放到最后，至少不丢
      take(() => true);
      return out;
    }

    /** 拿到当前可用的顺序表（老数据在这里折算）。 */
    function resolveLayout(state, systemLabels) {
      if (state && Array.isArray(state.layout)) return state.layout.slice();
      const legacy = (state && state.legacy) || [];
      if (legacy.length === 0) return systemLabels.map(sysKey);
      return legacyLayout(legacy, systemLabels || []);
    }

    /**
     * 补齐顺序表：丢掉已经不存在（分区被卸载）的入口、去重，
     * 再把系统里新冒出来的行按系统自己的顺序接到末尾——跟系统追加新面板的习惯一致。
     * @param layout - 现有顺序表。
     * @param systemLabels - 当前渲染出来的系统行标签，按 DOM 顺序。
     * @param hasSection - 某个设置分区是否还在。
     */
    function completeLayout(layout, systemLabels, hasSection) {
      const out = [];
      for (const key of layout || []) {
        if (isMine(key)) {
          if (!hasSection(mineId(key))) continue;
          if (out.indexOf(key) !== -1) continue;
          out.push(key);
          continue;
        }
        if (!isSys(key)) continue;
        if (out.indexOf(key) !== -1) continue;
        out.push(key);
      }
      for (const label of systemLabels || []) {
        const key = sysKey(label);
        if (out.indexOf(key) === -1) out.push(key);
      }
      return out;
    }

    function sameLayout(a, b) {
      if (!Array.isArray(a) || !Array.isArray(b)) return false;
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
      return true;
    }

    /** 整组面板是不是收起来了（收起来只留一行标题，把纵向空间还给会话列表）。 */
    function collapsedOf(state) {
      return !!(state && state.collapsed === true);
    }

    // ---------------------------------------------------------------- 持久化

    function readState() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return normalizeState(JSON.parse(raw));
        for (const key of LEGACY_KEYS) {
          const legacy = localStorage.getItem(key);
          if (legacy) return normalizeState(JSON.parse(legacy));
        }
      } catch (error) {
        /* 坏数据当作空 */
      }
      return normalizeState(null);
    }

    function currentState() {
      if (!memState) memState = readState();
      return memState;
    }

    /** 顺序表变了就通知设置面板（面板可能开着）。 */
    function emit() {
      const state = currentState();
      for (const listener of Array.from(listeners)) {
        try {
          listener(state);
        } catch (error) {
          /* 面板自己的错不该拖累侧边栏 */
        }
      }
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }

    /**
     * 落盘。传进来的可以只是要改的那几项（`{layout}` / `{collapsed}` / `{hidden}`），
     * 没传的沿用当前值——省得每个调用点都要把三样都抄一遍，抄漏一个就丢设置。
     */
    function saveState(next) {
      const base = currentState();
      const merged = {
        layout: next && next.layout !== undefined ? next.layout : base.layout,
        collapsed: next && next.collapsed !== undefined ? next.collapsed === true : collapsedOf(base),
        hidden: next && next.hidden !== undefined ? normalizeHidden(next.hidden) : hiddenOf(base)
      };
      memState = merged;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
        for (const key of LEGACY_KEYS) localStorage.removeItem(key);
      } catch (error) {
        /* 存不进去就只在本次会话生效 */
      }
      emit();
    }

    // ------------------------------------------------------------ 分区清单

    /** 读设置分区：返回按 order 排好的 `[{ id, order, label }]`，已排除本插件自己。 */
    function readSections(ctx) {
      let entries = [];
      try {
        entries = ctx.slots.entries('settings.section') || [];
      } catch (error) {
        entries = [];
      }
      const out = [];
      const seen = Object.create(null);
      for (const entry of entries) {
        const options = (entry && entry.options) || {};
        const id = options.id;
        if (!id || id === SECTION_ID || seen[id]) continue;
        let label = options.label;
        if (typeof label === 'function') {
          try {
            label = label();
          } catch (error) {
            label = undefined;
          }
        }
        if (typeof label !== 'string' || !label.trim()) continue;
        seen[id] = true;
        out.push({ id, order: typeof options.order === 'number' ? options.order : 0, label });
      }
      out.sort((a, b) => (a.order === b.order ? 0 : a.order < b.order ? -1 : 1));
      return out;
    }

    // ------------------------------------------- 打开设置并定位到某个分区

    /** 设置弹窗的面板节点（settings-general 在 panel 上打的那个标记）。 */
    const SETTINGS_PANEL = '[data-shortcut-modal="settings"]';
    /** 账号菜单按钮 aria-label 的候选写法（跟界面语言走）。 */
    const ACCOUNT_LABELS = ['账号菜单', 'account menu'];
    /** 账号菜单里「设置」那一项的文案候选。 */
    const SETTINGS_LABELS = ['设置', 'Settings'];

    function onScreen(el) {
      if (!el || !el.isConnected) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    /** 按下—抬起—点击三连：最终只补一次 click，不会把开关按钮点两下。 */
    function press(el) {
      if (!el) return;
      const opts = { bubbles: true, cancelable: true, view: window };
      try {
        el.dispatchEvent(new PointerEvent('pointerdown', opts));
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new PointerEvent('pointerup', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
      } catch (error) {
        /* 老 webview 没有 PointerEvent，直接 click */
      }
      el.click();
    }

    /** 逐帧轮询，最多 frames 帧；找不到返回 null。 */
    function waitFor(find, frames) {
      return new Promise((resolve) => {
        let left = typeof frames === 'number' ? frames : 60;
        const tick = () => {
          let found = null;
          try {
            found = find();
          } catch (error) {
            found = null;
          }
          if (found) {
            resolve(found);
            return;
          }
          left -= 1;
          if (left <= 0) {
            resolve(null);
            return;
          }
          requestAnimationFrame(tick);
        };
        tick();
      });
    }

    /** 账号菜单那颗按钮。 */
    function accountTrigger() {
      const buttons = Array.from(document.querySelectorAll('button[aria-haspopup="menu"]'));
      for (const button of buttons) {
        const label = (button.getAttribute('aria-label') || '').trim();
        if (ACCOUNT_LABELS.some((word) => label.toLowerCase() === word.toLowerCase())) return button;
      }
      return buttons.length ? buttons[buttons.length - 1] : null;
    }

    /** 弹出菜单里文字匹配的那一项。 */
    function menuItem(words) {
      const items = Array.from(document.querySelectorAll('button[role="menuitem"]')).filter(onScreen);
      for (const item of items) {
        const text = (item.textContent || '').trim();
        if (words.some((word) => text === word)) return item;
      }
      for (const item of items) {
        const text = (item.textContent || '').trim();
        if (words.some((word) => text && text.indexOf(word) !== -1)) return item;
      }
      return null;
    }

    /** 菜单候选的现场快照，失败时打进日志用。 */
    function menuReport(trigger) {
      const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
      const texts = items.map((item) => (item.textContent || '').trim() || '(空)');
      return (
        'trigger=' +
        (trigger ? (trigger.getAttribute('aria-label') || '(无label)') : '无') +
        ' expanded=' +
        (trigger ? trigger.getAttribute('aria-expanded') : '?') +
        ' menuitem=' +
        items.length +
        ' [' +
        texts.join(' / ') +
        ']'
      );
    }

    /** 设置弹窗左栏的分区行，返回 `[{ cell, text }]`。 */
    function navCells(root) {
      const nav = root.querySelector('nav') || root;
      const out = [];
      for (const cell of nav.querySelectorAll('button')) {
        const label = cell.querySelector('span[class*="navLabel"]');
        if (!label) continue;
        out.push({ cell, text: (label.textContent || '').trim() });
      }
      return out;
    }

    /** 按文字找分区行：先精确，再互相包含。 */
    function pickCell(root, label) {
      const cells = navCells(root);
      const exact = cells.find((cell) => cell.text === label);
      if (exact) return exact.cell;
      const loose = cells.find(
        (cell) => cell.text && (cell.text.indexOf(label) !== -1 || label.indexOf(cell.text) !== -1)
      );
      return loose ? loose.cell : null;
    }

    /**
     * 设置弹窗的开关状态是 settings-general 包里的一个 store，它随
     * `sidebar.settings` 这个 slot 的注册项一起挂出来（options.store）。
     * 拿到它就能直接"打开并定位到某分区"，不用去点界面上那颗按钮。
     */
    function settingsActions(ctx) {
      try {
        const entries = ctx.slots.entries('sidebar.settings') || [];
        for (const entry of entries) {
          const store = entry && (entry.store || (entry.options && entry.options.store));
          if (!store || typeof store.create !== 'function') continue;
          const instance = store.create();
          if (instance && instance.actions) return instance.actions;
        }
      } catch (error) {
        console.error('[dsh-visibility] 取设置 store 失败', error && error.message);
      }
      return null;
    }

    /** 直接让设置弹窗打开并停在 id 这个分区；成功返回 true。 */
    function openSectionById(ctx, id) {
      const actions = settingsActions(ctx);
      if (!actions) {
        let names = '';
        try {
          names = (ctx.slots.entries('sidebar.settings') || [])
            .map((entry) => Object.keys(entry.options || {}).join('+') + '/' + Object.keys(entry).join('+'))
            .join(' ; ');
        } catch (error) {
          names = 'entries 报错 ' + (error && error.message);
        }
        console.error('[dsh-visibility] 没拿到设置 store，entries=' + names);
        return false;
      }
      try {
        if (typeof actions.openSection === 'function') {
          actions.openSection(id);
          return true;
        }
        if (typeof actions.open === 'function') {
          actions.open();
          if (typeof actions.select === 'function') actions.select(id);
          return true;
        }
      } catch (error) {
        console.error('[dsh-visibility] 打开分区失败', error && error.message);
      }
      return false;
    }

    /** 打开设置弹窗并切到 `label` 那个分区。 */
    async function openSettingsAt(label) {
      let root = document.querySelector(SETTINGS_PANEL);
      if (!root) {
        const trigger = accountTrigger();
        if (!trigger) {
          const seen = Array.from(document.querySelectorAll('button[aria-haspopup]'))
            .map((button) => (button.getAttribute('aria-haspopup') || '?') + ':' + (button.getAttribute('aria-label') || '(无label)'));
          console.error('[dsh-visibility] 找不到账号菜单按钮，候选=' + seen.join(' / '));
          return false;
        }
        press(trigger);
        const item = await waitFor(() => menuItem(SETTINGS_LABELS), 40);
        if (!item) {
          console.error('[dsh-visibility] 账号菜单里没找到「设置」项 ' + menuReport(trigger));
          press(trigger);
          return false;
        }
        press(item);
        root = await waitFor(() => document.querySelector(SETTINGS_PANEL), 60);
        if (!root) {
          console.error('[dsh-visibility] 点了「设置」但弹窗没出现');
          return false;
        }
      }
      const cell = await waitFor(() => pickCell(root, label), 30);
      if (!cell) {
        console.error(
          '[dsh-visibility] 设置里没找到分区「' + label + '」，现有分区：' +
            navCells(root).map((item2) => item2.text).join(' / ')
        );
        return false;
      }
      press(cell);
      return true;
    }

    // ------------------------------------------------------- 侧边栏行注入

    function panelListEl() {
      return document.querySelector('[class*="_panelList"]');
    }

    /** 侧边栏里系统自带的那些行：`[{ el, label }]`，按 DOM 顺序（同名的只认第一个）。 */
    function systemRowsOf(list) {
      const out = [];
      const seen = Object.create(null);
      for (const button of list.querySelectorAll('button[class*="_panelRow"]')) {
        if (button.getAttribute(MARK)) continue;
        const label = button.getAttribute('aria-label');
        if (!label || seen[label]) continue;
        seen[label] = true;
        out.push({ el: button, label });
      }
      return out;
    }

    /** 只要标签（顺序表、设置面板都按标签认系统行）。 */
    function readSystemRows() {
      const list = panelListEl();
      if (!list) return [];
      return systemRowsOf(list).map((row) => row.label);
    }

    // ------------------------------------------------------------ 拖拽底座

    /** 从一次拖拽事件里取出被拖动的键（不是我们的就返回空串）。 */
    function dragKeyOf(event) {
      let raw = '';
      try {
        raw = event.dataTransfer.getData('text/plain') || '';
      } catch (error) {
        raw = '';
      }
      if (raw.indexOf(DRAG_PREFIX) !== 0) return '';
      return raw.slice(DRAG_PREFIX.length);
    }

    /**
     * `dragover` 期间浏览器把 dataTransfer 里的内容锁住了，`getData` 读出来是空，
     * 所以本页内先用内存里的 dragState 兜住，跨窗口/兜底再读 dataTransfer。
     */
    function currentDragKey(event) {
      if (dragState && dragState.key) return dragState.key;
      return dragKeyOf(event);
    }

    function startDrag(event, key) {
      dragState = { key };
      try {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', DRAG_PREFIX + key);
      } catch (error) {
        /* 某些 webview 不允许写 dataTransfer，靠 dragState 兜底 */
      }
    }

    function stopDrag() {
      dragState = null;
      clearIndicator();
    }

    /** 鼠标在这一行的上半还是下半：上半插它前面，下半插它后面。 */
    function isAfter(event, el) {
      const rect = el.getBoundingClientRect();
      return event.clientY > rect.top + rect.height / 2;
    }

    function clearIndicator(el) {
      const target = el || (indicator && indicator.el);
      if (!target) {
        indicator = null;
        return;
      }
      target.style.boxShadow = '';
      if (indicator && indicator.el === target) indicator = null;
    }

    function showIndicator(el, after) {
      if (indicator && indicator.el !== el) clearIndicator(indicator.el);
      indicator = { el };
      el.style.boxShadow = after ? LINE_BOTTOM : LINE;
    }

    /** 把 sourceKey 挪到 targetKey 前面/后面，落盘并重排。 */
    function moveEntry(ctx, sourceKey, targetKey, after) {
      if (!sourceKey || !targetKey || sourceKey === targetKey) return;
      const layout = resolveLayout(currentState(), readSystemRows());
      const rest = layout.filter((key) => key !== sourceKey);
      const found = rest.indexOf(targetKey);
      if (found === -1) return;
      rest.splice(after ? found + 1 : found, 0, sourceKey);
      commitLayout(ctx, rest);
    }

    function buildRow(ctx, summary) {
      const list = panelListEl();
      // 只拿系统行当样本——别把自己插进去的行当样本，不然会越抄越像自己
      const sampleRow = list ? list.querySelector('button[class*="_panelRow"]:not([' + MARK + '])') : null;
      const sampleGlyph = sampleRow ? sampleRow.querySelector('span[class*="_panelGlyph"]') : null;
      const sampleTitle = sampleRow ? sampleRow.querySelector('span[class*="_panelTitle"]') : null;
      const key = mineKey(summary.id);

      const row = document.createElement('button');
      row.type = 'button';
      row.setAttribute(MARK, 'row');
      row.setAttribute('data-dsh-link-id', summary.id);
      row.setAttribute('aria-label', summary.label);
      row.title = summary.label + '（点开设置分区；按住可拖动位置）';
      row.draggable = true;

      if (sampleRow && sampleRow.className) {
        row.className = String(sampleRow.className)
          .split(/\s+/)
          .filter((name) => name && name.indexOf('panelActive') === -1)
          .join(' ');
      }
      row.style.cursor = 'pointer';

      const glyph = document.createElement('span');
      if (sampleGlyph && sampleGlyph.className) glyph.className = sampleGlyph.className;
      glyph.innerHTML = ROW_ICON;

      const title = document.createElement('span');
      if (sampleTitle && sampleTitle.className) title.className = sampleTitle.className;
      title.textContent = summary.label;

      row.appendChild(glyph);
      row.appendChild(title);

      // 点击不在这里接：整行的命中交给列表上的统一代理（见 wireListClicks），
      // 图标、文字、内边距都算这一行，跟系统自带行的手感一致。

      // ---- 侧边栏内直接拖拽：只移动被拖的这一条 ----
      row.addEventListener('dragstart', (event) => {
        event.stopPropagation();
        startDrag(event, key);
        row.style.opacity = '0.4';
      });
      row.addEventListener('dragend', () => {
        stopDrag();
        row.style.opacity = '';
      });
      row.addEventListener('dragover', (event) => {
        const sourceKey = currentDragKey(event);
        if (!sourceKey || sourceKey === key) return;
        event.preventDefault();
        event.stopPropagation();
        showIndicator(row, isAfter(event, row));
      });
      row.addEventListener('dragleave', () => clearIndicator(row));
      row.addEventListener('drop', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const sourceKey = currentDragKey(event);
        const after = isAfter(event, row);
        clearIndicator(row);
        stopDrag();
        moveEntry(ctx, sourceKey, key, after);
      });

      return row;
    }

    /**
     * 本插件的行：直接挂在列表下面，跟系统行完全同构（系统行就是 nav 的直接子元素，
     * 靠 `align-items:stretch` 撑满整行）。集合变了才重建。
     */
    function ensureRows(ctx, list, mineKeys, byId) {
      // 上一代实例留下的行先清掉，免得点击落到旧逻辑上。
      for (const row of Array.from(list.querySelectorAll('[' + MARK + '="row"]'))) {
        if (row.getAttribute('data-gen') !== String(GEN)) row.remove();
      }
      // 0.3 及更早版本用 div 包了一层，这里顺手清掉
      for (const stale of Array.from(list.querySelectorAll('[' + MARK + '="row-holder"]'))) stale.remove();

      const mine = Array.from(list.querySelectorAll('[' + MARK + '="row"]'));
      if (mine.map((row) => row.getAttribute('data-key')).join('|') === mineKeys.join('|')) return;

      for (const row of mine) row.remove();
      for (const key of mineKeys) {
        const summary = byId[mineId(key)];
        if (!summary) continue;
        const row = buildRow(ctx, summary);
        row.setAttribute('data-key', key);
        row.setAttribute('data-gen', String(GEN));
        list.appendChild(row);
      }
    }

    /** 同一个分区 400ms 内只开一次，免得行内代理和别处各开一次。 */
    let lastOpenId = '';
    let lastOpenAt = 0;
    function openRowSection(ctx, id, label) {
      const now = Date.now();
      if (id === lastOpenId && now - lastOpenAt < 400) return;
      lastOpenId = id;
      lastOpenAt = now;
      // 首选：直接调设置弹窗的 store（立刻开在该分区）。
      if (openSectionById(ctx, id)) return;
      // 兜底：模拟"账号菜单 → 设置 → 分区"三步点击。
      openSettingsAt(label);
    }

    /**
     * 自检：本插件插进去的行，宽度该跟系统自带行一模一样（那样整行才都能点）。
     * 每次同步顺手量一下，对不上就记下来，面板里会红字提示。
     */
    let rowWidthGap = null;
    function measureRowWidth(list) {
      const sysRow = list.querySelector('button[class*="_panelRow"]:not([' + MARK + '])');
      const myRow = list.querySelector('[' + MARK + '="row"]');
      if (!sysRow || !myRow) {
        rowWidthGap = null;
        return;
      }
      const sysWidth = Math.round(sysRow.getBoundingClientRect().width);
      const myWidth = Math.round(myRow.getBoundingClientRect().width);
      rowWidthGap = sysWidth > 0 && myWidth > 0 && Math.abs(sysWidth - myWidth) > 1 ? { sysWidth, myWidth } : null;
    }

    /**
     * 整行都能点：监听挂在列表上、走捕获阶段，行内部怎么套（图标、文字、内边距）
     * 都不影响命中——系统自带行是整行响应，这里跟它对齐。
     */
    function wireListClicks(ctx, list) {
      if (list.getAttribute('data-dsh-click-wired') === String(GEN)) return;
      list.setAttribute('data-dsh-click-wired', String(GEN));
      list.addEventListener(
        'click',
        (event) => {
          if (window.__dshVisibilityGen !== GEN) return;
          const target = event.target instanceof Element ? event.target : null;
          if (!target) return;
          const row = target.closest('[' + MARK + '="row"]');
          if (!row || !list.contains(row)) return;
          const id = row.getAttribute('data-dsh-link-id') || '';
          if (!id) return;
          event.preventDefault();
          event.stopPropagation();
          openRowSection(ctx, id, row.getAttribute('aria-label') || id);
        },
        true
      );
    }

    /** 按顺序表给列表里每一行发 `order`——视觉顺序由这里定，DOM 顺序谁都不动。 */
    function applyOrder(list, layout) {
      const index = Object.create(null);
      layout.forEach((key, i) => {
        index[key] = i;
      });
      let extra = layout.length;
      for (const child of Array.from(list.children)) {
        if (child.getAttribute(MARK) === 'row') {
          const key = child.getAttribute('data-key') || '';
          if (key in index) child.style.order = String(index[key]);
          continue;
        }
        if (!child.matches || !child.matches('button[class*="_panelRow"]')) continue;
        if (child.getAttribute(MARK)) continue;
        const key = sysKey(child.getAttribute('aria-label') || '');
        if (key in index) child.style.order = String(index[key]);
        else child.style.order = String(extra++);
      }
    }

    /**
     * 给系统自带的行接上拖拽。
     *
     * 两个属性分工：`data-dsh-drag` 存这一行当前的键（界面语言一换标签就变，每次同步都要
     * 更新），`data-dsh-drag-wired` 只记"已经接过监听"，一辈子设一次。监听里一律现读键，
     * 免得语言切换后残留的旧监听拿着旧键去搬家。
     * React 不认识这两个属性，重渲染不会把它们冲掉。
     */
    function wireSystemRows(ctx, rows) {
      for (const { el, label } of rows) {
        el.setAttribute(DRAG_MARK, sysKey(label));
        if (el.getAttribute(DRAG_WIRED)) continue;
        el.setAttribute(DRAG_WIRED, '1');
        el.setAttribute('draggable', 'true');

        const keyOf = () => el.getAttribute(DRAG_MARK) || '';
        const live = () => window.__dshVisibilityGen === GEN;

        el.addEventListener('dragstart', (event) => {
          if (!live()) return;
          event.stopPropagation();
          startDrag(event, keyOf());
          el.style.opacity = '0.4';
        });
        el.addEventListener('dragend', () => {
          if (!live()) return;
          stopDrag();
          el.style.opacity = '';
        });
        el.addEventListener('dragover', (event) => {
          if (!live()) return;
          const key = keyOf();
          const sourceKey = currentDragKey(event);
          if (!sourceKey || sourceKey === key) return;
          event.preventDefault();
          event.stopPropagation();
          showIndicator(el, isAfter(event, el));
        });
        el.addEventListener('dragleave', () => {
          if (!live()) return;
          clearIndicator(el);
        });
        el.addEventListener('drop', (event) => {
          if (!live()) return;
          event.preventDefault();
          event.stopPropagation();
          const key = keyOf();
          const sourceKey = currentDragKey(event);
          const after = isAfter(event, el);
          clearIndicator(el);
          stopDrag();
          moveEntry(ctx, sourceKey, key, after);
        });
      }
    }

    /**
     * 把侧边栏同步成顺序表指定的样子；幂等——表没变就只重新分配 `order`，
     * 免得 MutationObserver 自己触发自己。
     */
    function syncRows(ctx, state) {
      if (window.__dshVisibilityGen !== GEN) return;
      const list = panelListEl();
      if (!list) return;

      const sections = readSections(ctx);
      const byId = Object.create(null);
      for (const section of sections) byId[section.id] = section;

      const rows = systemRowsOf(list);
      const labels = rows.map((row) => row.label);
      // 分区还没读到时不要拿"没有分区"去裁剪顺序表，否则会把用户的入口抹掉。
      const hasSection = sections.length === 0 ? () => true : (id) => byId[id] !== undefined;
      const layout = completeLayout(resolveLayout(state, labels), labels, hasSection);
      const collapsed = collapsedOf(state);
      // 藏起来的系统行不进顺序表以外的任何地方：顺序表里那条照样留着，位置就还在。
      const hidden = completeHidden(hiddenOf(state), labels);

      if (!sameLayout(layout, state && state.layout) || !sameLayout(hidden, hiddenOf(state))) {
        saveState({ layout, collapsed, hidden });
      }

      // 侧边栏缩成窄条时不能缩进子行，否则 36px 的方格塞不下图标
      const rail = !!list.closest('[class*="_collapsed"]');
      const hideMap = hiddenMap(hidden);
      ensureRows(ctx, list, layout.filter(isMine), byId);
      wireListClicks(ctx, list);
      applyOrder(list, layout);
      measureRowWidth(list);
      wireSystemRows(ctx, rows);
      // 标题行上的数字只算露出来的行，藏起来的不算——不然「还剩几行」就对不上了
      const visible = layout.filter((key) => !hideMap[key]).length;
      ensureHeader(ctx, list, collapsed, visible, rail);
      applyCollapse(list, collapsed, rail, hidden);
    }

    /** 落盘 + 重绘侧边栏，两件事一起做。 */
    function commitLayout(ctx, layout) {
      const collapsed = collapsedOf(currentState());
      saveState({ layout, collapsed });
      syncRows(ctx, { layout, collapsed });
    }

    /** 折叠/展开整组面板：只改这一个开关，行本身一个都不动。 */
    function toggleCollapsed(ctx) {
      const state = currentState();
      const next = {
        layout: resolveLayout(state, readSystemRows()),
        collapsed: !collapsedOf(state)
      };
      saveState(next);
      syncRows(ctx, next);
    }

    /**
     * 藏起 / 放回某一行系统自带的行。
     * 只改隐藏表，顺序表原样不动——所以放回来的时候它还站在原来的位置上。
     */
    function setHidden(ctx, key, hide) {
      if (!isSys(key)) return;
      const state = currentState();
      const hidden = hiddenOf(state).filter((item) => item !== key);
      if (hide) hidden.push(key);
      const next = {
        layout: resolveLayout(state, readSystemRows()),
        collapsed: collapsedOf(state),
        hidden
      };
      saveState(next);
      syncRows(ctx, next);
    }

    /**
     * 一次把藏起来的系统行全放回来（顺序表本来就没动过，所以位置原样）。
     */
    function showAllHidden(ctx) {
      const state = currentState();
      if (hiddenOf(state).length === 0) return;
      const next = {
        layout: resolveLayout(state, readSystemRows()),
        collapsed: collapsedOf(state),
        hidden: []
      };
      saveState(next);
      syncRows(ctx, next);
    }

    /**
     * 组的「外观」：子行统一往右缩进，挂在标题行下面；
     * 收起时把每一行藏起来（`display:none`），标题行留着——点它就能展开。
     * 单独被藏的行（`hidden`）也走同一条路：两种"藏"叠加，任一成立就 `display:none`。
     * 侧边栏缩成窄条（rail）时不缩进，否则图标会被挤出 36px 的方格。
     */
    function applyCollapse(list, collapsed, rail, hidden) {
      const hideMap = hiddenMap(hidden);
      const indent = rail ? '' : '30px';
      for (const child of Array.from(list.children)) {
        const mark = child.getAttribute(MARK);
        if (mark === 'panel-header') continue;
        if (mark === 'row') {
          const key = child.getAttribute('data-key') || '';
          child.style.display = collapsed || hideMap[key] ? 'none' : '';
          child.style.paddingLeft = indent;
          continue;
        }
        if (mark) continue;
        if (!child.matches || !child.matches('button[class*="_panelRow"]')) continue;
        const key = sysKey(child.getAttribute('aria-label') || '');
        child.style.display = collapsed || hideMap[key] ? 'none' : '';
        child.style.paddingLeft = indent;
      }
    }

    /**
     * 组的标题行：`≡ 扩展管理` + 右侧小箭头，点一下收起/展开。
     * 外观直接抄系统面板行（同一套 class），所以高度、悬停底色、字号都跟旁边的行一致；
     * 收起来时后面报个数字，免得忘了里面还压着东西。
     */
    function ensureHeader(ctx, list, collapsed, count, rail) {
      let header = list.querySelector('[' + MARK + '="panel-header"]');
      if (!header || header.getAttribute('data-gen') !== String(GEN)) {
        if (header) header.remove();
        header = document.createElement('button');
        header.type = 'button';
        header.setAttribute(MARK, 'panel-header');
        header.setAttribute('data-gen', String(GEN));
        header.style.order = '-1';

        // 抄一行系统面板的 class，省得自己重写一套间距和悬停色
        const sample = list.querySelector('button[class*="_panelRow"]:not([' + MARK + '])');
        if (sample && sample.className) {
          header.className = String(sample.className)
            .split(/\s+/)
            .filter((name) => name && name.indexOf('panelActive') === -1)
            .join(' ');
        }

        const glyph = document.createElement('span');
        glyph.setAttribute('data-role', 'glyph');
        if (sample) {
          const sampleGlyph = sample.querySelector('span[class*="_panelGlyph"]');
          if (sampleGlyph && sampleGlyph.className) glyph.className = sampleGlyph.className;
        }
        glyph.innerHTML = MENU_ICON;

        const label = document.createElement('span');
        label.setAttribute('data-role', 'label');
        if (sample) {
          const sampleTitle = sample.querySelector('span[class*="_panelTitle"]');
          if (sampleTitle && sampleTitle.className) label.className = sampleTitle.className;
        }
        label.style.flex = '1';
        label.style.minWidth = '0';

        const chevron = document.createElement('span');
        chevron.setAttribute('data-role', 'chevron');
        chevron.style.cssText = 'flex:none;font-size:9px;line-height:1;opacity:.45;margin-left:auto;';

        header.appendChild(glyph);
        header.appendChild(label);
        header.appendChild(chevron);
        header.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (window.__dshVisibilityGen !== GEN) return;
          toggleCollapsed(ctx);
        });
        list.insertBefore(header, list.firstChild);
      }

      const label = header.querySelector('[data-role="label"]');
      const chevron = header.querySelector('[data-role="chevron"]');
      if (label) {
        label.textContent = collapsed ? '扩展管理（' + count + '）' : '扩展管理';
        label.style.display = rail ? 'none' : '';
      }
      if (chevron) {
        chevron.textContent = collapsed ? '▸' : '▾';
        chevron.style.display = rail ? 'none' : '';
      }
      header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      header.setAttribute('aria-label', collapsed ? '展开扩展管理' : '收起扩展管理');
      header.title = collapsed ? '展开扩展管理（现在收着 ' + count + ' 行）' : '收起扩展管理，把纵向空间让给会话列表';
      header.style.display = count === 0 ? 'none' : '';
    }

    // ------------------------------------------------------------- 设置面板

    function buttonStyle() {
      return {
        font: 'inherit',
        fontSize: '13px',
        lineHeight: '18px',
        padding: '5px 10px',
        borderRadius: '7px',
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35))',
        background: 'transparent',
        color: 'inherit'
      };
    }

    function makePanel(ctx) {
      return function SidebarLinksPanel() {
        const [state, setLocalState] = React.useState(() => currentState());
        const [sections, setSections] = React.useState([]);
        const [systemRows, setSystemRows] = React.useState([]);
        const [dropKey, setDropKey] = React.useState('');
        const [dropAfter, setDropAfter] = React.useState(false);
        const [poolOver, setPoolOver] = React.useState(false);
        const dragRef = React.useRef(null);

        React.useEffect(() => {
          const pull = () => {
            setSections(readSections(ctx));
            setSystemRows(readSystemRows());
          };
          pull();
          let off = null;
          try {
            off = ctx.slots.subscribe('settings.section', pull);
          } catch (error) {
            off = null;
          }
          const offState = subscribe(setLocalState);
          return () => {
            if (typeof off === 'function') off();
            offState();
          };
        }, []);

        const commit = (layout) => {
          commitLayout(ctx, layout);
          setLocalState(currentState());
        };

        /** 藏起 / 放回一行系统自带的行（顺序表不动，位置记着）。 */
        const setRowHidden = (key, hide) => {
          setHidden(ctx, key, hide);
          setLocalState(currentState());
        };

        /** 一次全放回来。 */
        const showAll = () => {
          showAllHidden(ctx);
          setLocalState(currentState());
        };

        const hasSection = sections.length === 0 ? () => true : (id) => sections.some((section) => section.id === id);
        const layout = completeLayout(resolveLayout(state, systemRows), systemRows, hasSection);
        const hidden = completeHidden(hiddenOf(state), systemRows);
        const hiddenSet = hiddenMap(hidden);
        const isHidden = (key) => hiddenSet[key] === true;
        const labelOf = (id) => {
          const found = sections.find((section) => section.id === id);
          return found ? found.label : id;
        };

        // 从上到下的真实顺序：系统行和本插件的入口混在一张表里；
        // 藏起来的系统行不进这张表，它们在下区单独列一行「显示」按钮。
        const rows = layout
          .filter((key) => !isHidden(key))
          .map((key) =>
            isSys(key)
              ? { kind: 'system', key, label: sysLabel(key) }
              : { kind: 'mine', key, id: mineId(key), label: labelOf(mineId(key)) }
          );

        // 藏起来的系统行按原顺序排（位置记着，放回去还站老地方）
        const hiddenRows = layout
          .filter((key) => isSys(key) && isHidden(key))
          .map((key) => ({ key, label: sysLabel(key) }));

        const pool = sections.filter((section) => layout.indexOf(mineKey(section.id)) === -1);

        const begin = (event, key) => {
          dragRef.current = key;
          startDrag(event, key);
        };

        const finish = () => {
          dragRef.current = null;
          stopDrag();
          setDropKey('');
          setDropAfter(false);
          setPoolOver(false);
        };

        const dropOn = (index, after) => {
          const sourceKey = dragRef.current;
          setDropKey('');
          setDropAfter(false);
          if (!sourceKey) return;
          const target = rows[index];
          const rest = layout.filter((key) => key !== sourceKey);
          let at = rest.length;
          if (target) {
            const found = rest.indexOf(target.key);
            if (found !== -1) at = after ? found + 1 : found;
          }
          rest.splice(at, 0, sourceKey);
          dragRef.current = null;
          commit(rest);
        };

        const dropOnPool = () => {
          const sourceKey = dragRef.current;
          dragRef.current = null;
          stopDrag();
          setPoolOver(false);
          if (!sourceKey || isSys(sourceKey)) return;
          commit(layout.filter((key) => key !== sourceKey));
        };

        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },

          h(
            'p',
            { style: { margin: 0, fontSize: '13px', lineHeight: '20px', opacity: 0.7 } },
            '下面「未显示」里的分区，用鼠标拖到上面「侧边栏」里就显示；每一条都可以单独拖到任意两行之间——系统自带的行（标着「系统」）现在也能拖，顺序会被记住。把本插件的行拖回下面，就不显示了。系统自带的行右边有「隐藏」，点一下它就从侧边栏消失（位置给你记着，放回来还站老地方）。点侧边栏上的入口，会打开设置并直接定位到那个分区。侧边栏里这组行挂在「扩展管理」下面，点那一行就能整组收起（只留它自己），把纵向空间还给会话列表。'
          ),

          rowWidthGap &&
            h(
              'p',
              { style: { margin: 0, fontSize: '13px', color: '#c0392b' } },
              '自检：系统自带行宽 ' +
                rowWidthGap.sysWidth +
                'px，本插件的行宽 ' +
                rowWidthGap.myWidth +
                'px，两边对不上（这时候会出现「只有文字能点」）。把这一行截给我，我按这个数修。'
            ),

          // ---------------- 上区：侧边栏 ----------------
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
            h('div', { style: { fontSize: '13px', fontWeight: 500 } }, '侧边栏（从上到下）'),

            systemRows.length === 0 &&
              h('p', { style: { margin: 0, fontSize: '13px', opacity: 0.7 } }, '侧边栏还没读到，先关掉设置再打开试试。'),

            rows.map((row, index) => {
              const isDropTarget = dropKey === row.key;
              const common = {
                onDragOver: (event) => {
                  const sourceKey = dragRef.current || dragKeyOf(event);
                  if (!sourceKey || sourceKey === row.key) return;
                  event.preventDefault();
                  const rect = event.currentTarget.getBoundingClientRect();
                  const after = event.clientY > rect.top + rect.height / 2;
                  if (dropKey !== row.key || dropAfter !== after) {
                    setDropKey(row.key);
                    setDropAfter(after);
                  }
                },
                onDrop: (event) => {
                  event.preventDefault();
                  const rect = event.currentTarget.getBoundingClientRect();
                  dropOn(index, event.clientY > rect.top + rect.height / 2);
                }
              };

              const borderTop = isDropTarget && !dropAfter ? '2px solid var(--dsw-alias-label-primary, currentColor)' : '2px solid transparent';
              const borderBottom = isDropTarget && dropAfter ? '2px solid var(--dsw-alias-label-primary, currentColor)' : '2px solid transparent';

              if (row.kind === 'system') {
                return h(
                  'div',
                  Object.assign({ key: row.key }, common, {
                    draggable: true,
                    onDragStart: (event) => begin(event, row.key),
                    onDragEnd: finish,
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      padding: '8px 12px',
                      borderRadius: '8px',
                      fontSize: '14px',
                      cursor: 'grab',
                      borderTop,
                      borderBottom
                    }
                  }),
                  h('span', { style: { opacity: 0.45, cursor: 'grab' } }, '⋮⋮'),
                  h('span', { style: { flex: '1', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.label),
                  h('span', { style: { fontSize: '11px', opacity: 0.7 } }, '系统'),
                  h(
                    'button',
                    {
                      type: 'button',
                      onClick: () => setRowHidden(row.key, true),
                      style: Object.assign(buttonStyle(), { padding: '2px 8px', fontSize: '12px' })
                    },
                    '隐藏'
                  )
                );
              }

              return h(
                'div',
                Object.assign({ key: row.key }, common, {
                  draggable: true,
                  onDragStart: (event) => begin(event, row.key),
                  onDragEnd: finish,
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    padding: '8px 12px',
                    borderRadius: '8px',
                    background: 'var(--dsw-specific-sidebar-nav-item-active)',
                    fontSize: '14px',
                    cursor: 'grab',
                    borderTop,
                    borderBottom
                  }
                }),
                h('span', { style: { opacity: 0.45, cursor: 'grab' } }, '⋮⋮'),
                h('span', { style: { flex: '1', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.label),
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => commit(layout.filter((key) => key !== row.key)),
                    style: Object.assign(buttonStyle(), { padding: '2px 8px', fontSize: '12px' })
                  },
                  '移出'
                )
              );
            })
          ),

          // ---------------- 已隐藏（系统行） ----------------
          hiddenRows.length > 0 &&
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
              h('div', { style: { fontSize: '13px', fontWeight: 500 } }, '已隐藏（系统自带的行，点「显示」放回原位）'),
              hiddenRows.map((row) =>
                h(
                  'div',
                  {
                    key: row.key,
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      padding: '8px 12px',
                      borderRadius: '8px',
                      fontSize: '14px',
                      opacity: 0.75
                    }
                  },
                  h('span', { style: { flex: '1', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.label),
                  h('span', { style: { fontSize: '11px', opacity: 0.7 } }, '已隐藏'),
                  h(
                    'button',
                    {
                      type: 'button',
                      onClick: () => setRowHidden(row.key, false),
                      style: Object.assign(buttonStyle(), { padding: '2px 8px', fontSize: '12px' })
                    },
                    '显示'
                  )
                )
              )
            ),

          // ---------------- 下区：未显示 ----------------
          h(
            'div',
            {
              onDragOver: (event) => {
                if (!dragRef.current) return;
                event.preventDefault();
                if (!poolOver) setPoolOver(true);
              },
              onDragLeave: () => setPoolOver(false),
              onDrop: (event) => {
                event.preventDefault();
                dropOnPool();
              },
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
                padding: '8px',
                borderRadius: '10px',
                border: '1px dashed ' + (poolOver ? 'var(--dsw-alias-label-primary, currentColor)' : 'var(--dsw-alias-border-l1, rgba(127,127,127,.35))'),
                background: poolOver ? 'var(--dsw-specific-sidebar-nav-item-hover)' : 'transparent'
              }
            },
            h('div', { style: { fontSize: '13px', fontWeight: 500, padding: '0 4px 4px' } }, '未显示（拖到上面就显示）'),
            pool.length === 0
              ? h('p', { style: { margin: 0, padding: '0 4px', fontSize: '13px', opacity: 0.7 } }, '全都放到侧边栏了。')
              : pool.map((section) =>
                  h(
                    'div',
                    {
                      key: section.id,
                      draggable: true,
                      onDragStart: (event) => begin(event, mineKey(section.id)),
                      onDragEnd: finish,
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        padding: '8px 12px',
                        borderRadius: '8px',
                        fontSize: '14px',
                        cursor: 'grab'
                      }
                    },
                    h('span', { style: { opacity: 0.45, cursor: 'grab' } }, '⋮⋮'),
                    h('span', { style: { flex: '1', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, section.label),
                    h(
                      'button',
                      {
                        type: 'button',
                        onClick: () => commit(layout.concat(mineKey(section.id))),
                        style: Object.assign(buttonStyle(), { padding: '2px 8px', fontSize: '12px' })
                      },
                      '放上去'
                    )
                  )
                )
          ),

          h(
            'div',
            { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            h(
              'button',
              {
                type: 'button',
                onClick: () => commit(systemRows.map(sysKey).concat(layout.filter(isMine))),
                style: buttonStyle()
              },
              '恢复系统默认顺序'
            ),
            h('button', { type: 'button', onClick: () => commit(layout.filter(isSys)), style: buttonStyle() }, '全部移出'),
            hidden.length > 0 &&
              h('button', { type: 'button', onClick: showAll, style: buttonStyle() }, '全部显示（放回 ' + hidden.length + ' 行）'),
            h(
              'button',
              {
                type: 'button',
                onClick: () => toggleCollapsed(ctx),
                style: buttonStyle()
              },
              collapsedOf(state) ? '展开扩展管理' : '收起扩展管理'
            )
          )
        );
      };
    }

    // ------------------------------------------------------------------ 装配

    function apply(ctx) {
      ctx.effect(() => {
        const refresh = () => {
          try {
            syncRows(ctx, currentState());
          } catch (error) {
            console.error('[dsh-visibility] sync failed', error && (error.stack || error.message));
          }
        };

        // 侧边栏列表会被 React 重渲染，用 MutationObserver 合帧补回入口行和顺序。
        let frame = 0;
        const schedule = () => {
          if (frame) return;
          frame = requestAnimationFrame(() => {
            frame = 0;
            refresh();
          });
        };
        const observer = new MutationObserver(schedule);
        observer.observe(document.body, { childList: true, subtree: true });

        // 等在设置分区这个 slot 被声明后再注册自己的面板（声明感知的 inject）。
        const disposeSection = ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: SECTION_ID,
              order: 60,
              label: () => SECTION_LABEL
            },
            makePanel(ctx)
          )
        );

        refresh();

        return () => {
          observer.disconnect();
          if (frame) cancelAnimationFrame(frame);
          if (typeof disposeSection === 'function') disposeSection();
        };
      }, 'dsh-visibility: sidebar links');
    }

    return {
      inject: ['slots'],
      apply
    };
  }
});
