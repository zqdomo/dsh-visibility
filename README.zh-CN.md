# 侧边栏入口 · dsh-visibility

[![test](https://github.com/zqdomo/dsh-visibility/actions/workflows/test.yml/badge.svg)](https://github.com/zqdomo/dsh-visibility/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[English](README.md) · **简体中文**

![侧边栏入口面板](docs/screenshot-settings.png)

给 DSH 的左侧边栏加一个「入口管理器」：把设置里的任意分区变成侧边栏直达按钮，把侧边栏每一行（**包括系统自带的「插件」「任务」**）随意拖动排序、单独隐藏、整组收起。

纯客户端插件，不碰后端、不改数据库、不劫持 React 的渲染顺序——状态全部存在浏览器 `localStorage`，删掉目录就干净复原。

## 它能干什么

| 能力 | 说明 |
| --- | --- |
| **分区直达** | 设置里的每个分区（技能、模型、插件…）都能勾选成侧边栏入口，点一下直接打开设置并定位到那个分区 |
| **自由排序** | 侧边栏每一行都能拖，上拖下拖都行；系统自带的「插件」「任务」也照拖不误 |
| **单行隐藏** | 任何一行都能藏起来，**位置记着**——以后再点「显示」，它回到原来站的地方，不会跑到队尾 |
| **整组收起** | 一个「收起/展开」按钮把这一组入口折起来，只留一行标题，不占会话列表的地盘 |
| **一键还原** | 面板底部有「全部恢复显示」，误操作也能救回来 |
| **老数据迁移** | 自动识别并迁移 v1 / v2 / v3 版本的存储格式，升级不丢配置 |

## 怎么用

<img src="docs/screenshot-sidebar.png" alt="侧边栏效果" width="285">

1. 打开设置：点左下角头像，或按 `Ctrl + ,`
2. 左栏最下面找到 **「侧边栏入口」**
3. 面板分两块：
   - 上半块是**已经上到侧边栏的行**（顺序就是侧边栏的实际顺序）——拖动调整位置；系统自带的行右侧是「隐藏」（位置记住，随时放回来），自己添加的分区右侧是「移出」（摘回下面的候选区）
   - 下半块是**还没上来的设置分区**——点一下「放上去」就挂到侧边栏
4. 侧边栏上直接拖也行：拖到某一行的上半部分是插到它前面，下半部分是插到它后面
5. 侧边栏顶部那行「收起」能整组折叠

> 状态存在 `localStorage` 的 `dsh-sidebar-links.v4` 键里。换浏览器 profile 或换设备不会同步，属于预期行为。

## 安装

本插件的包名是 `@local/dsh-visibility`（保留 `@local` 前缀是为了兼容本地 `link:` 安装方式，不影响从 GitHub 安装）。

### 方式一：从 GitHub 安装（推荐给其他人）

编辑你的 DSH profile 配置 `~/.dsh/profiles/<profile>/package.json`，在 `dependencies` 里加一行：

```json
"@local/dsh-visibility": "git+https://github.com/zqdomo/dsh-visibility.git"
```

再把包名加进同一文件的 `dsh.profile.bundles` 数组：

```json
"dsh": {
  "profile": {
    "bundles": [
      "...",
      "@local/dsh-visibility"
    ]
  }
}
```

然后在 `~/.dsh/profiles/<profile>/` 下执行一次 `npm install`（或 `pnpm install`），重启 DSH。

### 方式二：本地开发安装

把仓库克隆到任意目录，然后用 `link:` 指过去：

```json
"@local/dsh-visibility": "link:D:/path/to/dsh-visibility"
```

同样要加进 `dsh.profile.bundles`，重启 DSH 生效。

### 卸载

从 `dependencies` 和 `dsh.profile.bundles` 里删掉那两行，重启即可。`localStorage` 里残留的键可以手动清掉，不清也没影响。

## 原理（为什么这么做）

DSH 的设置弹窗开关状态由 `settings-general` 包内私有的 store 持有，没有对外服务；`settings.open` 命令在桌面端只走原生键盘分发，合成 `KeyboardEvent` 无效。所以本插件不去「叫开」设置，而是走**真实 UI 路径**：

```
账号菜单按钮 (button[aria-haspopup="menu"])
  → 菜单项「设置」(button[role="menuitem"])
    → 弹窗 [data-shortcut-modal="settings"] 里的分区 navCell
```

三步都是真实 DOM，点出来的就是用户自己点出来的效果。

**排序**不改 DOM 顺序：侧边栏列表是 `display:flex; flex-direction:column`，插件给每一行写 CSS `order`，视觉顺序随便排，React 对此一无所知，也就永远不会把顺序改回去。

**隐藏**用行内 `display:none`，React 只认自己的 props，不会去清 `style.display`。

**热替换安全**：每次加载发一个递增的实例代次（`window.__dshVisibilityGen`），不是最新代次的实例自动停摆，避免热更新后两个实例抢点击。

## 已知限制

- 依赖 DSH 当前的 DOM 结构（aria-label、`data-shortcut-modal` 等）。DSH 大改版后可能失效，届时改 `client.js` 顶部的选择器常量即可。
- 只在客户端（Web / 桌面端 WebView）生效，Host 侧是空 `apply()`，不注册任何能力。
- 配置按浏览器存储，不同步、不共享。
- 侧边栏极窄（rail 模式）时入口会被压成方块图标，这是跟随系统行宽度的结果。

## 开发

```
dsh-visibility/
├── index.js              # Host 半边：空 apply()，只为让 Loader 认领本包
├── client.js             # 客户端半边：全部逻辑（约 1500 行，含大段设计注释）
├── cordis.patch.yml      # Loader patch：把本包插进插件树
├── package.json
├── docs/                 # 截图
└── tests/
    ├── order.test.cjs         # 顺序表纯函数测试（迁移、补全、移动下标）
    └── apply-order.test.cjs   # applyOrder 的假 DOM 测试
```

跑测试（不需要装依赖，纯 Node）：

```bash
npm test
# 等价于
node tests/order.test.cjs && node tests/apply-order.test.cjs
```

测试的做法是从 `client.js` 里**按标记/函数签名原文抽出**要测的代码块再跑，所以改了实现也不会因为行号变化而失效；代价是那些标记注释（`const SYS = 'sys:'`、`持久化`、函数签名）不能随手删。

改客户端代码时记住 DSH 的热更新特性：`client.js` 被替换后旧实例不会销毁，所以任何新增的全局监听都要挂上代次判断。

## License

[MIT](./LICENSE) © 2026 zqdomo
