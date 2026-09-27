# 玻光画布 · Task Manager

一款**玻璃拟态风**的桌面任务管理应用。基于 **Tauri 2 + Vite + 原生 JS**，无框架依赖、体积小、启动快。
桌面端数据存本地 SQLite，浏览器预览时自动降级到 localStorage，两种模式无缝兼容。

<div align="center">

![Version](https://img.shields.io/badge/version-1.0.27-blue)
![Tauri](https://img.shields.io/badge/Tauri-2.5-orange)
![Vite](https://img.shields.io/badge/Vite-6.3-purple)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![License](https://img.shields.io/badge/license-MIT-green)

</div>

---

## ✨ 核心特性

### 📋 任务画布

- **三段式布局**：已完成 / 待确认 / 待完成 三个分区，用两条分界线隔开，视觉一眼可辨。
- **拖拽操作**：卡片可直接拖到任意区域；拖入已完成区会自动切换完成态；拖入待确认区则进入 review 态。
- **靠左对齐开关**：待完成区支持「从上到下靠左对齐」一键重排；对齐偏好跨标签切换持久生效。
- **放大编辑**：双击卡片进入「放大编辑」态，编辑完成后再退出，位置自动恢复。
- **便签墙**：右上角「速记夹」是独立的便利贴画布，支持自由摆放、任意缩放，与主任务流互不干扰。

### 🧠 思维模式

独立的思维导图画布，支持中心节点 + 分支扩展；切走再切回不影响任务区状态。

### 🎨 图片墙

- 图片上传、分组、组合（Ctrl+M 合成一张 PNG）、拆分（Ctrl+Z）；
- 批量对齐工具：左右上下 / 水平垂直居中；
- 选中态显示工具栏（不选中时默认收起，避免遮挡内容）；
- 图片数据独立存储，与任务数据完全解耦。

### 🔁 数据与可靠性

- **桌面端**：Tauri IPC → Rust SQLite 持久化，跨会话不丢数据。
- **浏览器预览**：自动降级到 localStorage，无需后端也能体验。
- **降级容错**：IPC 挂掉时前端累计失败次数分级告警（1 / 10 / 50 次阈值），恢复后自动把降级期写入 localStorage 的孤儿数据回灌到 SQLite。
- **自动更新**：集成 Tauri Updater + rsign/minisign 签名校验，密钥轮换见 [RELEASE_GUIDE.md](./RELEASE_GUIDE.md)。

---

## 🚀 快速开始

### 环境要求

- **Node.js 20+**
- **Rust stable**（仅桌面构建需要；浏览器预览可跳过）
- Windows / macOS / Linux

### 安装 & 开发

```bash
# 1. 克隆仓库
git clone https://github.com/a136249692/renwu.git
cd renwu

# 2. 安装依赖
npm ci

# 3. 浏览器预览（不需要 Rust 工具链）
npm run dev

# 4. 桌面端开发（需要 Rust 工具链）
npm run tauri dev

# 5. 桌面端打包
npm run tauri build
```

### 运行测试

测试都是无头 Node 脚本，无需启动浏览器：

```bash
# 单文件测试
node test/*.test.mjs

# 或者直接逐个跑
for f in test/*.test.mjs; do node "$f"; done
```

现有测试覆盖：滚动定位新块、tab 切换重布局、便利贴墙、对齐算法等回归点。

---

## 📁 项目结构

```
task-manager/
├─ src/
│  ├─ index.html       # 单页入口，三大 tab 布局
│  ├─ main.js          # 任务画布核心：三段式布局、拖拽、SQLite/localStorage 适配
│  ├─ mindmap.js       # 思维模式：tab 切换、导图渲染
│  ├─ image-wall.js    # 图片墙：上传、组合、拆分、对齐
│  └─ styles.css       # 玻璃拟态视觉
├─ src-tauri/
│  ├─ tauri.conf.json  # 应用配置（版本号、窗口、updater 公钥）
│  ├─ Cargo.toml       # Rust 依赖
│  └─ src/             # Rust IPC 端点：SQLite 存储层
├─ test/               # 无头回归测试
├─ .github/workflows/
│  └─ tauri-build.yml  # Release CI：签名打包 + CNB 镜像
├─ RELEASE_GUIDE.md    # 发版流程手册
└─ package.json
```

---

## 🏗️ 架构

```
┌─────────────────────────────────────────────────┐
│   浏览器渲染进程 (JS)                             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐        │
│  │ main.js  │ │ mindmap  │ │ img-wall │        │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘        │
│       │            │            │                │
│  ┌────▼────────────▼────────────▼────┐          │
│  │  Tauri 适配层（detectTauri()）      │          │
│  └────┬─────────────────────┬────────┘          │
└───────┼─────────────────────┼────────────────────┘
        │ invoke              │
        ▼                     ▼
   ┌─────────┐         ┌────────────┐
   │ Rust    │         │ 浏览器      │
   │ SQLite  │         │ localStorage│
   └─────────┘         └────────────┘
```

关键设计：**同一份业务代码**通过 `detectTauri()` 判定运行环境，`invoke()` 失败自动降级到 localStorage，
前端代码对存储介质零感知；IPC 挂掉后的孤儿数据在恢复时会通过 `migrateOrphansToSqlite()` 回灌。

---

## 📦 发布 & 自动更新

发版流程见 **[RELEASE_GUIDE.md](./RELEASE_GUIDE.md)**，最短路径：

```bash
# 升 3 处版本号（package.json / package-lock.json × 2 / tauri.conf.json）
# 一条命令批量替换
OLD=1.0.27 && NEW=1.0.28
sed -i "s/${OLD}/${NEW}/g" package.json package-lock.json src-tauri/tauri.conf.json

git add -A
git commit -m "chore(release): v${NEW} - <说明>"
git tag -a v${NEW} -m "v${NEW} - <说明>"
git push origin main v${NEW}
```

CI 由 tag push 自动触发（`.github/workflows/tauri-build.yml`），会：

1. 在 Windows 上构建 NSIS exe + WiX msi；
2. 用 rsign/minisign 签名，生成 `latest.json` 供 Tauri Updater 拉取；
3. 上传到 GitHub Release **和** CNB（`shiyishi-2026/surenwu`）镜像仓；
4. 把 GitHub Release 的 `latest.json` 里的 URL 替换成 CNB 链接，方便国内用户高速下载。

签名密钥已配置在 GitHub Secrets 中，无需本地签名。

---

## ⌨️ 快捷键

| 快捷键 | 作用 |
|---|---|
| `Ctrl+Q` | 新建便签（速记夹） |
| `Ctrl+M` | 组合选中图片为一张 PNG |
| `Ctrl+Z` | 拆分组合图片 |
| `Ctrl+Shift+G` | 图片编组 |
| `Ctrl+Shift+U` | 图片解散组 |
| `双击卡片` | 放大编辑 |
| `双击标题` | 重命名文件夹 / 应用 |

---

## 🧩 技术栈

- **前端**：原生 HTML / CSS / JS（无框架、无构建产物压缩器额外依赖）
- **构建**：[Vite 6](https://vitejs.dev/)
- **桌面壳**：[Tauri 2](https://tauri.app/)
- **持久化**：Rust SQLite（桌面端）/ Web Storage（浏览器兜底）
- **自动更新**：Tauri Updater + rsign/minisign 签名
- **CI**：GitHub Actions + CNB CodeNav 镜像

---

## 📝 许可

MIT License。
