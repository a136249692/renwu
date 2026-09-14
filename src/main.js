import { invoke as invokeImpl } from "@tauri-apps/api/core";
import { check as checkUpdate } from "@tauri-apps/plugin-updater";

/* ═══════════════════════════════════════════════════ *
 *  Tauri / localStorage 双模式适配层
 *  桌面端走 invoke → Rust/SQLite；浏览器预览走 localStorage
 * ═══════════════════════════════════════════════════ */
// Tauri 检测：__TAURI_INTERNALS__（IPC 注入）或 withGlobalTauri 注入的 window.__TAURI__
// 桌面端两者都在；浏览器预览里都没有 → 自动走 localStorage 兜底。
function detectTauri() {
  if (typeof window === "undefined") return false;
  if ("__TAURI_INTERNALS__" in window) return true;
  const t = window.__TAURI__;
  return !!(t && (t.core || t.invoke));
}
const isTauri = detectTauri;
const STICKY_FOLDER = "速记夹";

/* ---------- IPC 健康跟踪 ----------
 * invoke 失败时仍返回 null（api 方法用 if(result) 判空，null 自动回退 localStorage），
 * 但副作用里累计失败次数、标记降级、触发分级告警；恢复时触发回灌迁移。 */
const ipcState = {
  failures: 0,       // 累计 IPC 失败次数
  fallback: false,   // 当前是否处于降级模式（IPC 挂了，走 localStorage）
  toastShown: false, // 本次会话是否已弹过首次告警
  lastTier: 0,       // 上次告警达到的阈值档位（1=首次, 2=10次, 3=50次）
};

async function invoke(cmd, args) {
  if (!isTauri()) return null;
  try {
    const result = await invokeImpl(cmd, args);
    if (ipcState.fallback) {
      // IPC 从故障恢复 → 标记解除，并尝试把降级期写入 localStorage 的孤儿数据回灌 SQLite
      ipcState.fallback = false;
      migrateOrphansToSqlite();
    }
    return result;
  } catch (err) {
    ipcState.failures++;
    ipcState.fallback = true;
    console.warn(`[玻光画布] invoke("${cmd}") 失败，已切换 localStorage:`, err);
    notifyFallback();
    return null;
  }
}

/* 分级告警：首次失败立即弹；之后累计 10/50 次时各弹一次更新，避免连环弹 */
function notifyFallback() {
  if (!ipcState.toastShown) {
    ipcState.toastShown = true;
    ipcState.lastTier = 1;
    toast("数据库连接异常，已切换本地缓存。数据仍在本机可用，但重启后可能丢失。");
    return;
  }
  const tiers = [[10, 2], [50, 3]];
  for (const [threshold, tier] of tiers) {
    if (ipcState.failures >= threshold && ipcState.lastTier < tier) {
      ipcState.lastTier = tier;
      toast(`数据库仍异常（已累计 ${ipcState.failures} 次）。请检查路径权限或重启应用。`);
      return;
    }
  }
}

/* 回灌迁移：IPC 恢复后，把降级期间写入 localStorage 的孤儿数据导回 SQLite。
 * 仅在「曾发生过降级」时执行；迁移成功后清空 localStorage 孤儿数据。 */
async function migrateOrphansToSqlite() {
  let data;
  try { data = lsLoadAll(); }
  catch { return; }
  const orphanFolders = data.folders || [];
  const orphanTasks = data.tasks || [];
  if (!orphanFolders.length && !orphanTasks.length) return;
  console.info(`[玻光画布] IPC 已恢复，开始回灌 ${orphanFolders.length} 个夹 / ${orphanTasks.length} 个任务`);
  // 建立「旧 folderId → 新 folderId」映射，避免重复创建
  const folderMap = new Map();
  const existingFolders = await invokeImpl("get_folders");
  for (const orphan of orphanFolders) {
    const dup = (existingFolders || []).find(f => f.name === orphan.name);
    if (dup) { folderMap.set(orphan.id, dup.id); continue; }
    const created = await invokeImpl("create_folder", { name: orphan.name });
    if (created) folderMap.set(orphan.id, created.id);
  }
  let migrated = 0;
  for (const ot of orphanTasks) {
    const fid = folderMap.get(ot.folder_id);
    if (!fid) continue;
    try {
      const t = await invokeImpl("create_task", {
        folderId: fid, content: ot.content,
        positionX: ot.x || 16, positionY: ot.y || 100,
      });
      if (t && ot.is_completed) await invokeImpl("toggle_task", { id: t.id, isCompleted: true });
      if (t) migrated++;
    } catch (e) { console.warn("[玻光画布] 回灌任务失败:", ot.id, e); }
  }
  // 迁移完成的孤儿数据清空，避免下次重复回灌
  try { localStorage.removeItem("glassCanvas.v1"); } catch (_) {}
  console.info(`[玻光画布] 回灌完成，迁移 ${migrated} 个任务`);
  if (migrated > 0) {
    toast(`数据库已恢复，${migrated} 条本地缓存已同步。`);
    // 重新加载当前夹，让回灌的数据出现在画布上
    if (activeFolderId) { await reloadFolders(); await reloadTasks(); renderAll(); }
  }
}

/* ---------- 轻量错误提示 ---------- */
let _toastTimer = null;
function toast(msg) {
  let t = document.getElementById("app-toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "app-toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove("show"), 3500);
}
window.addEventListener("unhandledrejection", ev => {
  const r = ev.reason;
  const m = (r && (r.message || r.toString())) || String(r) || "未知错误";
  console.error("[玻光画布] 未处理的保存/读取错误:", m);
  // 只提示一次保存类错误，避免刷屏
  toast("读取或保存失败，请检查路径权限。详情见开发者面板: " + m.slice(0, 40));
});

const DIVIDER_KEY = "glassCanvas.dividers";
const SCROLL_KEY = "glassCanvas.scroll";
const DONE_SORT_KEY = "glassCanvas.doneSort";
const DEFAULT_FOLDER_KEY = "glassCanvas.defaultFolder";
const FOLDER_ORDER_KEY = "glassCanvas.folderOrder";

/* ---------- 应用标题（用户偏好，用于左上角品牌名 + 窗口标题） ---------- */
const APP_TITLE_KEY = "glassCanvas.appTitle";
const APP_TITLE_DEFAULT = "玻光画布";
const APP_TITLE_MAX = 20;
function getAppTitle() {
  try {
    const v = localStorage.getItem(APP_TITLE_KEY);
    return v ? v.trim() : APP_TITLE_DEFAULT;
  } catch { return APP_TITLE_DEFAULT; }
}
function setAppTitle(v) {
  const s = String(v || "").trim().slice(0, APP_TITLE_MAX) || APP_TITLE_DEFAULT;
  try { localStorage.setItem(APP_TITLE_KEY, s); } catch {}
  return s;
}

/* ---------- 任务夹顺序 ----------
   拖动排序后持久化到 localStorage。key 为文件夹 id，value 为索引。
   新增的文件夹若不在 map 中，会自动追加到末尾。 */
function getFolderOrderMap() {
  try { return JSON.parse(localStorage.getItem(FOLDER_ORDER_KEY) || "{}"); }
  catch { return {}; }
}
function saveFolderOrderMap(map) {
  try { localStorage.setItem(FOLDER_ORDER_KEY, JSON.stringify(map)); } catch {}
}

/* ---------- 默认任务夹 ---------- */
function getDefaultFolderId() {
  try {
    const v = localStorage.getItem(DEFAULT_FOLDER_KEY);
    return v == null || v === "" ? null : Number(v);
  } catch { return null; }
}
function setDefaultFolderId(id) {
  try { localStorage.setItem(DEFAULT_FOLDER_KEY, String(id)); } catch {}
}

/* 已完成区排序模式：默认按日期（旧→新），手动拖动后切到自由排序 */
function getDoneSortMode() {
  try {
    const m = JSON.parse(localStorage.getItem(DONE_SORT_KEY) || "{}");
    return m[activeFolderId] || "date";
  } catch { return "date"; }
}
function setDoneSortMode(mode) {
  try {
    const m = JSON.parse(localStorage.getItem(DONE_SORT_KEY) || "{}");
    m[activeFolderId] = mode;
    localStorage.setItem(DONE_SORT_KEY, JSON.stringify(m));
  } catch {}
}

/* ---------- localStorage 模拟后端（浏览器预览用） ---------- */
function lsLoadAll() {
  try { return JSON.parse(localStorage.getItem("glassCanvas.v1") || "{}"); }
  catch { return {}; }
}
function lsSaveAll(data) {
  localStorage.setItem("glassCanvas.v1", JSON.stringify(data));
}
const mockId = { n: 1 };
/* 兜底模式下生成全局唯一 id：从已有数据中取最大 id+1，
   避免新建文件夹与「我的任务」等既有对象撞 id（否则新夹存不上）。 */
function nextMockId() {
  try {
    const d = lsLoadAll();
    let m = 0;
    (d.folders || []).forEach(f => m = Math.max(m, Number(f.id) || 0));
    (d.tasks || []).forEach(t => m = Math.max(m, Number(t.id) || 0));
    mockId.n = m + 1;
  } catch { mockId.n = (mockId.n || 0) + 1; }
  return mockId.n;
}

/* ---------- 便利贴内容解析 ----------
 * 便利贴夹的块内容使用 "### 标题\n\n正文" 约定（分隔符：### + 空格 + 标题 + 空行）。
 * 普通任务夹不会出现此约定，故不影响其他文件夹。 */
function parseStickyContent(raw) {
  const text = String(raw || "");
  const m = text.match(/^\s*###\s+(.+?)(?:\n\n|\n(?=\S)|\s*$)([\s\S]*)$/);
  if (!m) return { title: "", body: text };
  return { title: m[1].trim(), body: m[2].replace(/^\s+/, "") };
}
function composeStickyContent(title, body) {
  title = String(title || "").trim();
  body = String(body || "");
  return title ? `### ${title}\n\n${body}` : body;
}

/* ---------- 统一数据映射：后端 snake_case → 前端 block 对象 ---------- */
function mapTask(t) {
  return {
    id: t.id,
    folderId: t.folder_id,
    title: t.content,
    done: !!t.is_completed,
    createdAt: t.created_at,
    x: t.x || 0,
    y: t.y || 0,
    row: !!t.is_completed,
    w: 0,
  };
}

/* ---------- API ---------- */
const api = {
  async getFolders() {
    if (isTauri()) {
      const list = await invoke("get_folders");
      if (list) return list.map(f => ({ ...f, dividerY: getDividerY(f.id) }));
    }
    const d = lsLoadAll();
    const fs = d.folders || [];
    // 自愈：保证任务夹 id 全局唯一（历史版本曾把新夹与默认夹做成相同 id，导致串数据）
    const seen = new Set();
    let last = fs.reduce((m, f) => Math.max(m, Number(f.id) || 0), 0);
    let changed = false;
    for (const f of fs) {
      const key = String(f.id);
      if (seen.has(key)) { f.id = ++last; changed = true; }
      seen.add(key);
    }
    if (changed) lsSaveAll(d);
    return fs;
  },
  async createFolder(name) {
    if (isTauri()) {
      const f = await invoke("create_folder", { name });
      if (f) return { ...f, dividerY: getDividerY(f.id) };
    }
    const d = lsLoadAll();
    const f = { id: nextMockId(), name: name.trim() || "未命名", created_at: Date.now(), total: 0, completed: 0, dividerY: 0 };
    d.folders = d.folders || []; d.folders.push(f); lsSaveAll(d);
    return f;
  },
  async renameFolder(id, name) {
    if (isTauri()) return invoke("rename_folder", { id, name });
    const d = lsLoadAll();
    const f = (d.folders || []).find(x => x.id === id);
    if (f) f.name = name;
    lsSaveAll(d);
  },
  async deleteFolder(id) {
    if (isTauri()) return invoke("delete_folder", { id });
    const d = lsLoadAll();
    d.folders = (d.folders || []).filter(x => x.id !== id);
    d.tasks = (d.tasks || []).filter(t => t.folder_id !== id);
    lsSaveAll(d);
  },
  async getTasks(folderId) {
    if (isTauri()) {
      const list = await invoke("get_tasks", { folderId });
      if (list) return list.map(mapTask);
    }
    const d = lsLoadAll();
    return (d.tasks || []).filter(t => t.folder_id === folderId).map(mapTask);
  },
  async createTask(folderId, title, x, y) {
    if (isTauri()) {
      const t = await invoke("create_task", { folderId, content: title, positionX: x, positionY: y });
      if (t) return mapTask(t);
    }
    const d = lsLoadAll();
    const t = { id: nextMockId(), folder_id: folderId, content: title, is_completed: 0, created_at: Date.now(), sort_order: 0, x, y };
    d.tasks = d.tasks || []; d.tasks.push(t); lsSaveAll(d);
    return mapTask(t);
  },
  async updateContent(id, content) {
    if (isTauri()) return invoke("update_task_content", { id, content });
    const d = lsLoadAll();
    const t = (d.tasks || []).find(x => x.id === id);
    if (t) t.content = content;
    lsSaveAll(d);
  },
  async moveTask(id, x, y) {
    if (isTauri()) return invoke("update_task_position", { id, x, y });
    const d = lsLoadAll();
    const t = (d.tasks || []).find(x => x.id === id);
    if (t) { t.x = x; t.y = y; }
    lsSaveAll(d);
  },
  async toggleTask(id, isCompleted) {
    if (isTauri()) {
      const t = await invoke("toggle_task", { id, isCompleted });
      if (t) return mapTask(t);
    }
    const d = lsLoadAll();
    const t = (d.tasks || []).find(x => x.id === id);
    if (t) t.is_completed = isCompleted ? 1 : 0;
    lsSaveAll(d);
    return mapTask(t);
  },
  async deleteTask(id) {
    if (isTauri()) return invoke("delete_task", { id });
    const d = lsLoadAll();
    d.tasks = (d.tasks || []).filter(x => x.id !== id);
    lsSaveAll(d);
  },
  /* 打开数据目录：仅桌面端支持，浏览器预览模式下按钮会被隐藏 */
  async openDataDir() {
    if (!isTauri()) return null;
    return invoke("open_data_dir");
  },
  /* 保存任务变更历史 */
  async saveTaskHistory(taskId, oldContent, newContent, changeType) {
    if (isTauri()) return invoke("save_task_history", { taskId, oldContent, newContent, changeType });
    const d = lsLoadAll();
    d.history = d.history || [];
    d.history.push({ task_id: taskId, old_content: oldContent, new_content: newContent, change_type: changeType, changed_at: Date.now() });
    lsSaveAll(d);
  },
};

/* ---------- 分界线位置（localStorage，纯前端偏好） ---------- */
function getDividerY(folderId) {
  try {
    const map = JSON.parse(localStorage.getItem(DIVIDER_KEY) || "{}");
    return map[folderId] || 0;
  } catch { return 0; }
}
function setDividerY(folderId, y) {
  try {
    const map = JSON.parse(localStorage.getItem(DIVIDER_KEY) || "{}");
    map[folderId] = y;
    localStorage.setItem(DIVIDER_KEY, JSON.stringify(map));
  } catch {}
}

/* ═══════════════════════════════════════════════════ *
 *  应用状态
 * ═══════════════════════════════════════════════════ */
const GRID = 22;
const SNAP = 5;
const DIVIDER_RATIO = 0.3;
const MIN_DIVIDER_Y = 56; // 已完成区最小高度，防止分界线贴顶塌缩
const CANVAS_BOTTOM_PAD = 1000; // 画布底部留白（像素），保证待完成区下方还能继续向下滚动

let folders = [];
let blocks = [];
let activeFolderId = null;
let saveTimer = null;
let savedPositions = {};
let alignMode = false;

/* ---------- DOM 引用 ---------- */
const $ = id => document.getElementById(id);
const canvas = $("canvas");
const board = $("board");
const canvasWrap = $("canvas-wrap");
const divider = $("divider");
const guideV = $("guide-v");
const guideH = $("guide-h");
const folderListEl = $("folder-list");
const folderTitle = $("folder-title");
const folderMeta = $("folder-meta");
const brandTitleEl = $("brand-title");
const alignToggle = $("align-toggle");
const boardEmpty = $("board-empty");
const stickyPopup = $("sticky-popup");
const stickyInput = $("sticky-input");
const stickyTitle = $("sticky-title");
const stickyHeader = $("sticky-header");
const folderTitleSticky = $("folder-title-sticky");
const stickyCount = $("sticky-count");
const stickySearchInput = $("sticky-search-input");
const stickySearchClear = $("sticky-search-clear");
const viewWallBtn = $("view-wall");
const viewListBtn = $("view-list");
const stickyAddBtn = $("sticky-add");

/* ---------- 速记夹状态 ---------- */
let stickyFolderId = null;
/* ---------- 便利贴视图状态 ---------- */
let stickyViewMode = "wall";   // "wall" | "list"
let stickyQuery = "";          // 搜索关键词
const STICKY_VIEW_KEY = "glassCanvas.stickyViewMode";
try {
  const saved = localStorage.getItem(STICKY_VIEW_KEY);
  if (saved === "list" || saved === "wall") stickyViewMode = saved;
} catch {}
/* 便签颜色循环（墙模式下按 index 轮询，视觉上更活泼） */
const STICKY_COLORS = [
  "#fff9c4", /* 黄 */
  "#ffd8bf", /* 橘 */
  "#c8f4d6", /* 绿 */
  "#c5e1ff", /* 蓝 */
  "#e8d5ff", /* 紫 */
  "#ffd1e3", /* 粉 */
];
/* 便签旋转角度（按 id 稳定派生，±3deg） */
function stickyRotation(id) {
  const seed = String(id || 0).split("").reduce((a, c) => a + (c.charCodeAt(0) || 0), 0);
  return ((seed % 15) - 7) * 0.4;  // -2.8 ~ +2.8 度
}

/* ---------- 文件夹拖动排序状态 ---------- */
let _dragFolderId = null;   // 正在拖动的文件夹 id
let _dragLastX = null;      // 拖拽最后一次的鼠标 X 坐标（用于决定插入到目标之前/之后）
let _dragLastY = null;      // 拖拽最后一次的鼠标 Y 坐标

/* ---------- 工具 ---------- */
function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts), p = n => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function escapeHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function isStickyFolder(f) {
  return f.name === STICKY_FOLDER || f.name === "便利贴";
}
/* 当前 activeFolder 是否是便利贴夹（速记夹） */
function isStickyFolderActive() {
  if (!activeFolderId) return false;
  const f = folders.find(x => x.id === activeFolderId);
  return !!f && isStickyFolder(f);
}

/* ---------- 分界线 ----------
   比例由 DIVIDER_RATIO 决定（0.3 = 完成区 30% / 待完成区 70%）。
   分界线的像素值按文件夹缓存在 localStorage 的 DIVIDER_KEY 里；
   relayout 会用 floor = max(已存值, 新默认) 保留较大的旧值，
   所以比例一改必须清空旧缓存，否则分界线会被旧值锁住、改了也不动。 */
const DIVIDER_RATIO_KEY = "glassCanvas.dividerRatio";
const DIVIDER_RATIO_VERSION = "r0.3";
// 比例变更后清空旧的比例缓存：旧值（如 0.4 时代写入的）会在 relayout 里被
// floor = max(已存值, 新默认) 当作下限保留，导致改比例后分界线纹丝不动。
try {
  if (localStorage.getItem(DIVIDER_RATIO_KEY) !== DIVIDER_RATIO_VERSION) {
    localStorage.setItem(DIVIDER_RATIO_KEY, DIVIDER_RATIO_VERSION);
    localStorage.removeItem(DIVIDER_KEY);
  }
} catch {}

function defaultDividerY() {
  const h = canvas.clientHeight || window.innerHeight;
  return Math.max(MIN_DIVIDER_Y, Math.round(h * DIVIDER_RATIO));
}
function dividerY() {
  const f = folders.find(x => x.id === activeFolderId);
  if (f && f.dividerY) return f.dividerY;
  return defaultDividerY();
}
function paintDivider() {
  divider.style.top = dividerY() + "px";
}
// 落盘一个块的坐标（桌面端写 SQLite，浏览器端写 localStorage）
function persistBlockPosition(b) {
  api.moveTask(b.id, b.x, b.y);
}
/* relayout 重排后，所有已完成块的 y 都变了（堆叠位置被重新分配），
   必须全部落盘，否则刷新后只有被拖的块坐标是对的，其他块回到旧位置导致顺序错乱 */
function persistAllDonePositions() {
  for (const b of blocks) {
    if (b.done) persistBlockPosition(b);
  }
}

/* ---------- 待完成块靠左对齐 / 恢复原位 ---------- */
function alignPendingBlocks() {
  const pending = blocks.filter(b => !b.done);
  if (!pending.length) return;
  savedPositions = {};
  pending.forEach(b => { savedPositions[b.id] = { x: b.x, y: b.y }; });
  pending.sort((a, b) => (a.y || 0) - (b.y || 0));
  const els = pending.map(b => {
    const el = board.querySelector(`.block[data-id="${b.id}"]`);
    if (el) el.classList.add("align-anim");
    return el;
  });
  const startX = 20;
  let cursorY = dividerY() + 16;
  const GAP = 12;
  pending.forEach((b, i) => {
    const el = els[i];
    const h = el ? el.offsetHeight : 48;
    b.x = startX;
    b.y = cursorY;
    b.row = false;
    if (el) {
      el.classList.remove("row");
      encodePos(el, b);
    }
    persistBlockPosition(b);
    cursorY += h + GAP;
  });
  let maxY = cursorY + 40;
  for (const b of blocks) {
    const el = board.querySelector(`.block[data-id="${b.id}"]`);
    maxY = Math.max(maxY, b.y + (el ? el.offsetHeight : 48) + 40);
  }
  board.style.height = Math.max(maxY, canvas.clientHeight - 2) + "px";
  setTimeout(() => els.forEach(el => el && el.classList.remove("align-anim")), 340);
}

function restorePendingBlocks() {
  const els = blocks.filter(b => !b.done && savedPositions[b.id]).map(b => {
    const el = board.querySelector(`.block[data-id="${b.id}"]`);
    if (el) el.classList.add("align-anim");
    return el;
  });
  for (const b of blocks) {
    if (b.done) continue;
    const sv = savedPositions[b.id];
    if (!sv) continue;
    b.x = sv.x; b.y = sv.y;
    const el = board.querySelector(`.block[data-id="${b.id}"]`);
    if (el) encodePos(el, b);
    persistBlockPosition(b);
  }
  savedPositions = {};
  relayout(false);
  setTimeout(() => els.forEach(el => el && el.classList.remove("align-anim")), 340);
}

/* ---------- 渲染侧栏 ---------- */
function renderFolders() {
  folderListEl.innerHTML = "";
  // 排序：先按「非速记夹」的手动顺序（持久化在 FOLDER_ORDER_KEY），
  // 没有手动顺序的按 folders 数组顺序追加；速记夹永远排最前。
  const orderMap = getFolderOrderMap();
  const normal = folders.filter(f => !isStickyFolder(f));
  const sticky = folders.filter(f => isStickyFolder(f));
  normal.sort((a, b) => {
    const oa = orderMap[String(a.id)];
    const ob = orderMap[String(b.id)];
    // 有手动顺序的优先按顺序；没有的按 id（近似创建顺序）排
    if (oa !== undefined && ob !== undefined) return oa - ob;
    if (oa !== undefined) return -1;
    if (ob !== undefined) return 1;
    return (a.id || 0) - (b.id || 0);
  });
  const sorted = [...sticky, ...normal];
  const defId = getDefaultFolderId();
  sorted.forEach(f => {
    const locked = isStickyFolder(f);
    const isDefault = f.id === defId;
    const li = document.createElement("li");
    li.className = "folder-item" + (f.id === activeFolderId ? " active" : "") + (locked ? " locked" : "") + (locked ? "" : " draggable");
    li.dataset.id = f.id;
    if (!locked) li.setAttribute("draggable", "true");
    const starHtml = isDefault
      ? '<span class="default-badge" title="默认任务夹：每次打开应用都会先显示此夹">默认</span>'
      : '<button class="star-btn" title="设为默认任务夹">☆</button>';
    const handleHtml = locked
      ? '<span class="drag-handle" title="固定位置，不可拖动">⋮⋮</span>'
      : '<span class="drag-handle" title="拖动可调整位置">⋮⋮</span>';
    li.innerHTML = `${handleHtml}<span class="ico">📁</span><span class="name"></span>${starHtml}${locked ? '<span class="lock-icon">🔒</span>' : ''}<button class="rm" title="删除任务夹">×</button>`;
    li.querySelector(".name").textContent = f.name;
    li.addEventListener("click", e => {
      if (e.target.classList.contains("rm") || e.target.classList.contains("star-btn")) return;
      selectFolder(f.id);
    });
    if (!locked) {
      li.querySelector(".rm").addEventListener("click", e => {
        e.stopPropagation(); removeFolder(f.id);
      });
    }
    if (!isDefault) {
      const starBtn = li.querySelector(".star-btn");
      if (starBtn) starBtn.addEventListener("click", e => {
        e.stopPropagation();
        setDefaultFolderId(f.id);
        renderFolders();
        toast(`已将「${f.name}」设为默认任务夹`);
      });
    }
    li.addEventListener("dblclick", e => {
      if (e.target.classList.contains("rm") || e.target.classList.contains("star-btn")) return;
      openModal("rename", f);
    });
    // 拖动排序：只有非速记夹可以拖动
    if (!locked) {
      li.addEventListener("dragstart", e => {
        if (e.target.closest(".rm") || e.target.closest(".star-btn")) { e.preventDefault(); return; }
        _dragFolderId = f.id;
        _dragLastX = e.clientX;
        _dragLastY = e.clientY;
        li.classList.add("dragging");
        folderListEl.classList.add("reordering");
        try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(f.id)); } catch (_) {}
      });
      li.addEventListener("dragend", () => {
        li.classList.remove("dragging");
        folderListEl.classList.remove("reordering");
        folderListEl.querySelectorAll(".drag-over").forEach(x => x.classList.remove("drag-over"));
        _dragFolderId = null;
        _dragLastX = null;
        _dragLastY = null;
      });
      li.addEventListener("dragover", e => {
        if (_dragFolderId === null) return;
        e.preventDefault();
        _dragLastX = e.clientX;
        _dragLastY = e.clientY;
        if (li.dataset.id !== String(_dragFolderId)) li.classList.add("drag-over");
        else li.classList.remove("drag-over");
      });
      li.addEventListener("dragleave", () => {
        li.classList.remove("drag-over");
      });
      li.addEventListener("drop", e => {
        e.preventDefault();
        li.classList.remove("drag-over");
        if (_dragFolderId === null) return;
        const targetId = Number(li.dataset.id);
        if (targetId === _dragFolderId) return;
        reorderFolders(_dragFolderId, targetId);
      });
    }
    folderListEl.appendChild(li);
  });
}

/* 拖动文件夹到目标文件夹位置：把源元素插到目标之前/之后。
   以鼠标落点相对目标元素的中线决定插入到目标之前还是之后；
   自动适配纵向列表（用 Y）和移动端横向列表（用 X）。 */
function reorderFolders(srcId, targetId) {
  const srcIdx = folders.findIndex(f => f.id === srcId);
  const tgtIdx = folders.findIndex(f => f.id === targetId);
  if (srcIdx < 0 || tgtIdx < 0 || srcIdx === tgtIdx) return;
  const src = folders.splice(srcIdx, 1)[0];
  // 移除 src 后目标位置可能左移一位；重新定位
  let insertAt = folders.findIndex(f => f.id === targetId);
  if (insertAt < 0) { folders.splice(srcIdx, 0, src); return; }
  const tgtEl = folderListEl.querySelector(`li[data-id="${targetId}"]`);
  if (tgtEl) {
    const r = tgtEl.getBoundingClientRect();
    // 检测列表布局方向（自适应移动端横向布局）
    const isVertical = getComputedStyle(folderListEl).flexDirection !== "row";
    const pastMid = isVertical
      ? (_dragLastY != null && _dragLastY > r.top + r.height / 2)
      : (_dragLastX != null && _dragLastX > r.left + r.width / 2);
    if (pastMid) insertAt = insertAt + 1;
  }
  folders.splice(insertAt, 0, src);
  // 持久化顺序（只记录非速记夹）
  const map = {};
  folders.forEach((f, i) => { if (!isStickyFolder(f)) map[String(f.id)] = i; });
  saveFolderOrderMap(map);
  renderFolders();
}

/* ---------- 渲染画布（协调式：新增才建，多余才删） ---------- */
function renderAll() {
  renderFolders();
  const f = folders.find(x => x.id === activeFolderId);
  if (!f) {
    folderTitle.textContent = "请选择任务夹";
    stickyHeader.hidden = true;
    $("stage-header").hidden = false;
    return;
  }
  folderTitle.textContent = f.name;

  const isSticky = isStickyFolderActive();
  /* 便利贴夹：切到专用 header，隐藏画布分界线和普通提示 */
  $("stage-header").hidden = isSticky;
  stickyHeader.hidden = !isSticky;
  if (isSticky) {
    folderTitleSticky.textContent = f.name;
    divider.hidden = true;
    $("done-hint").hidden = true;
    guideV.hidden = true;
    guideH.hidden = true;
    /* 清空普通任务的「待完成 X」标签 */
    const pLabel = $("pending-label");
    const tLabel = $("done-label");
    if (pLabel) pLabel.textContent = "";
    if (tLabel) tLabel.textContent = "";
    alignToggle.parentElement.hidden = true;
  } else {
    divider.hidden = false;
    alignToggle.parentElement.hidden = false;
  }
  const existing = new Map();
  [...board.querySelectorAll(".block")].forEach(el => existing.set(Number(el.dataset.id), el));
  blocks.forEach(b => {
    let el = existing.get(b.id);
    if (el) { existing.delete(b.id); el.__b = b; }
    else { board.appendChild(makeBlock(b)); }
  });
  existing.forEach(el => el.remove()); // 清掉多余节点

  if (isSticky) {
    applyStickyLayout();
    applyStickySearch();
    renderStickyHeader();
  } else {
    relayout(false);
    restoreScroll();
    /* 恢复 board-empty 的默认文案（避免从便利贴夹切回时显示便签文案） */
    boardEmpty.classList.remove("search-empty");
    if (blocks.length === 0) {
      boardEmpty.hidden = false;
      boardEmpty.innerHTML =
        '<b>双击空白处</b> 即可输入任务<br />输入完成后，把块拖到任意位置摆放<br />拖到分界线上方即为「已完成」，下方为「待完成」';
    } else {
      boardEmpty.hidden = true;
    }
  }
}

/* ═══════════════════════════════════════════════════ *
 *  便利贴墙：布局、搜索、header 状态
 * ═══════════════════════════════════════════════════ */

/* 决定一个块是否被搜索关键词命中（标题 / 正文，忽略大小写） */
function stickyMatches(el, q) {
  if (!q) return true;
  const text = ((el.__parsedTitle || "") + " " + (el.__parsedBody || "")).toLowerCase();
  return text.includes(q);
}

/* 按关键词过滤 + 高亮命中片段；返回命中数量 */
function applyStickySearch() {
  const q = String(stickyQuery || "").trim().toLowerCase();
  const blocks_els = [...board.querySelectorAll(".block.sticky")];
  let hit = 0;
  for (const el of blocks_els) {
    const body = el.querySelector(".block-title");
    const st = el.querySelector(".sticky-title");
    const matched = stickyMatches(el, q);
    if (!matched) {
      el.classList.add("sticky-hidden");
    } else {
      el.classList.remove("sticky-hidden");
      hit++;
      if (body) renderHighlight(body, el.__parsedBody || "", q);
      if (st) renderHighlight(st, el.__parsedTitle || "", q);
    }
  }
  const empty = boardEmpty;
  if (empty) {
    const isEmpty = blocks.length === 0;
    const noHit = q && hit === 0;
    if (isEmpty) {
      empty.hidden = false;
      empty.classList.remove("search-empty");
      empty.innerHTML = '<b>按 Ctrl+Q</b> 或点击右上「＋」<br />新建一张便签';
    } else if (noHit) {
      empty.hidden = false;
      empty.classList.add("search-empty");
      empty.innerHTML = `未找到与「<b>${escapeHtml(q)}</b>」相关的便签`;
    } else {
      empty.hidden = true;
      empty.classList.remove("search-empty");
    }
  }
  return hit;
}

/* 高亮渲染：把 text 里匹配 q 的片段用 <mark> 包起来。
 * 用 innerHTML 写入，但对原文做过 escape，故不会引入 HTML 注入。 */
function renderHighlight(el, text, q) {
  if (!el) return;
  text = String(text || "");
  if (!q) { el.innerHTML = escapeHtml(text); return; }
  const idx = text.toLowerCase().indexOf(q);
  if (idx < 0) { el.innerHTML = escapeHtml(text); return; }
  const before = escapeHtml(text.slice(0, idx));
  const mid = escapeHtml(text.slice(idx, idx + q.length));
  const after = escapeHtml(text.slice(idx + q.length));
  el.innerHTML = `${before}<mark>${mid}</mark>${after}`;
}

/* 应用「墙 / 列表」视图。墙模式下用 CSS Grid + 便签色 + 旋转；列表模式下单列纵向。 */
function applyStickyLayout() {
  board.classList.toggle("sticky-wall", stickyViewMode === "wall");
  board.classList.toggle("sticky-list", stickyViewMode === "list");
  const blocks_els = [...board.querySelectorAll(".block.sticky")];
  blocks_els.forEach((el, i) => {
    if (stickyViewMode === "wall") {
      el.style.setProperty("--sticky-bg", STICKY_COLORS[i % STICKY_COLORS.length]);
      el.style.setProperty("--rot", stickyRotation(el.dataset.id) + "deg");
    } else {
      el.style.setProperty("--sticky-bg", "#fff");
      el.style.setProperty("--rot", "0deg");
    }
    el.style.top = "";
    el.style.left = "";
  });
  board.style.height = "auto";
}

/* 更新便利贴 header 的计数 / 视图按钮 / 搜索清空按钮可见性 */
function renderStickyHeader() {
  const total = blocks.length;
  const q = String(stickyQuery || "").trim();
  let hit = total;
  if (q) {
    hit = [...board.querySelectorAll(".block.sticky")].filter(el =>
      !el.classList.contains("sticky-hidden")
    ).length;
  }
  if (stickyCount) {
    stickyCount.textContent = q ? `${hit} / ${total} 便签` : `${total} 便签`;
  }
  if (stickySearchClear) stickySearchClear.hidden = !q;
  if (viewWallBtn && viewListBtn) {
    const wall = stickyViewMode === "wall";
    viewWallBtn.setAttribute("aria-selected", String(wall));
    viewListBtn.setAttribute("aria-selected", String(!wall));
    viewWallBtn.classList.toggle("active", wall);
    viewListBtn.classList.toggle("active", !wall);
  }
}

/* 定位一个已存在的块元素 */
function encodePos(el, b) {
  el.style.top = b.y + "px";
  if (b.row) { el.style.left = ""; el.style.right = "20px"; }
  else el.style.left = b.x + "px";
}

/* 已完成块按顺序堆叠：默认按创建时间从远到近排序（旧→新），
   手动拖动后切到自由排序（按 y 位置）。
   insertB 为「刚拖入完成区」的块：不靠 createdAt 插顶，而是按 drop 时的 y
   相对已有块的位置决定插入索引，插到对应位置（顶/中/底） */
function layoutDoneRows(insertB) {
  const mode = getDoneSortMode();
  const others = blocks.filter(b => b.done && b !== insertB).sort(
    mode === "manual" ? (a, b) => a.y - b.y : (a, b) => a.createdAt - b.createdAt
  );
  let insertIdx = others.length; // 默认插到最后（drop 在最下）
  if (insertB) {
    // 用 drop 位置对比已有块的旧 y，找到第一个「中心点在 drop 之下」的位置
    const dropCenter = insertB.y;
    for (let i = 0; i < others.length; i++) {
      const el = board.querySelector(`.block[data-id="${others[i].id}"]`);
      const h = el ? el.offsetHeight : 44;
      if (dropCenter < others[i].y + h / 2) { insertIdx = i; break; }
    }
    others.splice(insertIdx, 0, insertB);
  }
  let cursor = 14;
  for (const b of others) {
    b.x = 20; b.row = true;
    const el = board.querySelector(`.block[data-id="${b.id}"]`);
    const h = el ? el.offsetHeight : 44;
    b.y = cursor;
    cursor += h + 10;
  }
  return { doneList: others, total: cursor - 10 };
}

/* 下一次 relayout 要把哪个块按 drop 位置插入已完成区（拖入完成区时设置，
   relayout 消费后立即清空；其余场景保持 null，走 createdAt/manual 排序） */
let pendingInsert = null;

/* 就地重排：只改位置/类名，不重建 DOM（无闪烁、无 blockIn 重播） */
function relayout(initial) {
  // 先设置类，确保按最终形态（.done/.row）算出真实高度
  for (const b of blocks) {
    const el = board.querySelector(`.block[data-id="${b.id}"]`);
    if (!el) continue;
    el.classList.toggle("done", b.done);
    el.classList.toggle("row", b.row);
  }
  // insertB 是「本次刚拖入已完成区」的块，用于按 drop 位置决定插入索引；
  // 其余场景（加载、勾选、拖回待完成）为 null，走 createdAt / manual 排序
  const insertB = pendingInsert ? blocks.find(x => x.id === pendingInsert) : null;
  const { doneList, total } = layoutDoneRows(insertB);
  pendingInsert = null; // 一次性：本次插入消费后即清空，避免影响后续 relayout
  const need = doneList.length ? 14 + total + 46 : 0;
  const defY = defaultDividerY();
  const f = folders.find(x => x.id === activeFolderId);
  // 分界线 = max(defY, need)：
  //   · defY 下限（30%）—— 已完成内容少时也保证有一个够大的拖入目标区，
  //     不再因为内容少而把分界线顶到贴顶、导致「必须拖到很上边才能归入已完成」
  //   · need 随内容增长 —— 内容多时分界线下移让位，内容始终精确容纳、不溢出
  //   · 不再用「已存 dividerY」作下限：旧值会在内容收缩后把分界线顶住、
  //     已完成区变小了分界线却纹丝不动，中间留一块空白
  const dy = Math.max(defY, need);
  if (f) { f.dividerY = dy; setDividerY(activeFolderId, dy); }
  paintDivider();

  // 越界清理：分界线随已完成内容下移后，原先紧贴分界线下方摆放的待完成块会
  // 被「顶」进已完成区、被堆叠的已完成内容压住（如 E12 拖入后淹没了「123」）。
  // 这里把上沿仍在分界线之上的待完成块逐个推回分界线下方的空位并立即落盘；
  // 下移会腾出空位，后续越界块再落进来，链式补位直到无重叠
  for (const b of blocks) {
    if (b.done) continue;
    const el3 = board.querySelector(`.block[data-id="${b.id}"]`);
    if (!el3) continue;
    if (b.y < dy) {
      findFreeSpot(b, dy, true);
      persistBlockPosition(b);
    }
  }

  const todo = blocks.filter(b => !b.done).length;
  const done = blocks.length - todo;
  boardEmpty.hidden = blocks.length > 0;
  const doneHint = $("done-hint");
  if (doneHint) doneHint.hidden = !(blocks.length > 0 && done === 0);
  const pLabel = $("pending-label");
  if (pLabel) pLabel.innerHTML = `待完成 <b>${todo}</b>`;
  const topLabel = divider.querySelector(".label.top");
  if (topLabel) topLabel.textContent = done ? `已完成 ${done}` : "已完成";

  // 画布高度：待完成块也纳入计算（否则滚到分界线下方 200px 就触底），
  // 再额外留 CANVAS_BOTTOM_PAD 的空白区，让页面可以持续向下滚
  let maxY = dy + CANVAS_BOTTOM_PAD;
  for (const b of blocks) {
    const el2 = board.querySelector(`.block[data-id="${b.id}"]`);
    maxY = Math.max(maxY, b.y + (el2 ? el2.offsetHeight : 44) + 40);
  }
  board.style.height = Math.max(maxY, canvas.clientHeight - 2) + "px";

  for (const b of blocks) {
    const el = board.querySelector(`.block[data-id="${b.id}"]`);
    if (!el) continue;
    const check = el.querySelector(".block-check");
    if (check) check.textContent = b.done ? "✓" : "";
    encodePos(el, b);
  }
  // 已完成块整体置于画布最底层
  doneList.forEach(b => {
    const el = board.querySelector(`.block[data-id="${b.id}"]`);
    if (el) board.appendChild(el);
  });
}

/* 两个矩形是否重叠（块的 y 已在调用处 clamp 到分界线下方） */
function rectsOverlap(x1, y1, w1, h1, x2, y2, w2, h2) {
  return x1 < x2 + w2 && x1 + w1 > x2 && y1 < y2 + h2 && y1 + h1 > y2;
}
/* 待完成区摆放：从分界线下方按行扫描，行内由左到右、行间由上到下、紧凑排列。
   扫描行的 y 由「上一行块的实际底部」决定（而非固定步长）——固定步长在块高度
   不一时会把新块压到上一行还没结束的块上，这就是便签互相重叠的根因。
   fromTop=true：从分界线下方第一行开始扫（新便签、标记为未完成的块）。
   fromTop=false：从该块旧 y 所在行开始扫（拖拽落点，保留用户的垂直落点）。 */
function findFreeSpot(b, dy, fromTop) {
  const top = dy + 16;
  for (const o of blocks) {
    if (o.id === b.id || o.done) continue;
    const el = board.querySelector(`.block[data-id="${o.id}"]`);
    if (el) { o.w = el.offsetWidth; o.h = el.offsetHeight; }
  }
  const selfEl = board.querySelector(`.block[data-id="${b.id}"]`);
  if (selfEl) {
    const cls = selfEl.classList;
    cls.remove("done", "row");
    b.w = selfEl.offsetWidth; b.h = selfEl.offsetHeight;
  }
  const w = Math.max(180, b.w || 200), h = Math.max(40, b.h || 48);
  const boardW = board.clientWidth || 900;
  const maxX = Math.max(16, boardW - w - 16);
  const xStart = fromTop ? 16 : Math.min(Math.max(16, b.x || 16), maxX);
  const startY = fromTop ? top : Math.max(top, b.y || top);
  for (let x = xStart, y = startY, tries = 0; tries < 80; tries++) {
    let curX = x, placed = false, maxBottom = 0;
    while (curX <= maxX) {
      let rowBottom = 0;
      for (const o of blocks) {
        if (o.id === b.id || o.done) continue;
        const oy = Math.max(top, o.y || 0);
        const ow = Math.max(180, o.w || 200), oh = Math.max(40, o.h || 48);
        if (rectsOverlap(curX, y, w, h, o.x, oy, ow, oh)) {
          if (oy + oh > rowBottom) rowBottom = oy + oh;
        }
      }
      if (rowBottom === 0) { placed = true; break; }
      if (rowBottom > maxBottom) maxBottom = rowBottom;
      curX += 140;
    }
    if (placed) { b.x = Math.min(curX, maxX); b.y = y; return; }
    if (maxBottom === 0) break;
    y = maxBottom + 12; // 下一行：紧贴上一行所有块的最大底部
    x = 16;
  }
  b.x = Math.min(xStart, maxX);
  b.y = Math.max(top, y);
}

/* ---------- 生成任务块 ---------- */
function makeBlock(b) {
  const el = document.createElement("div");
  el.className = "block" + (b.done ? " done" : "") + (b.row ? " row" : "");
  el.style.top = b.y + "px";
  if (!b.row) el.style.left = b.x + "px";
  el.dataset.id = b.id;
  el.__b = b;

  /* 便利贴夹：解析 "### 标题\n\n正文" 约定。
   * 标题走独立 .sticky-title 元素（不可编辑），正文走原 .block-title（可编辑）。
   * 编辑时只编辑正文；标题保持不变。普通文件夹不解析。 */
  const inSticky = isStickyFolderActive();
  const parsed = inSticky ? parseStickyContent(b.title) : { title: "", body: b.title || "" };
  if (inSticky) {
    el.classList.add("sticky", "no-row");
    el.__parsedTitle = parsed.title;
    el.__parsedBody = parsed.body;
  }

  const title = document.createElement("div");
  title.className = "block-title";
  title.textContent = parsed.body;
  title.contentEditable = "false";
  title.spellcheck = false;

  const meta = document.createElement("div");
  meta.className = "block-meta";
  meta.textContent = fmtTime(b.createdAt);

  const check = document.createElement("button");
  check.className = "block-check";
  check.textContent = b.done ? "✓" : "";
  check.title = b.done ? "标记为未完成" : "标记为完成";
  check.addEventListener("click", e => { e.stopPropagation(); toggleDone(b.id); });

  const del = document.createElement("button");
  del.className = "block-del";
  del.textContent = "×";
  del.title = "删除";
  del.addEventListener("click", e => {
    e.stopPropagation();
    if (!confirm("确定删除此内容块？此操作不可撤销。")) return;
    removeBlock(b.id);
  });

  if (inSticky) {
    /* 便利贴夹：无完成/未完成概念，隐藏勾选；有标题时置顶 */
    check.remove();
    if (parsed.title) {
      const st = document.createElement("div");
      st.className = "sticky-title";
      st.textContent = parsed.title;
      st.title = "标题";
      el.appendChild(st);
    }
    el.append(title, meta, del);
  } else {
    el.append(title, meta, check, del);
  }

  el.addEventListener("dblclick", e => {
    if (e.target === check || e.target === del) return;
    startEdit(el, b);
  });
  title.addEventListener("input", () => {
    const txt = getTitleText(title);
    /* 便利贴夹：input 时把 body 与解析出的标题重新拼合（### 标题\n\n正文），
     * 保持 b.title 为完整原文；同时写库。普通夹：b.title = 纯文本。 */
    if (el.classList.contains("sticky")) {
      b.title = composeStickyContent(el.__parsedTitle || "", txt);
    } else {
      b.title = txt;
    }
    flashSave();
    api.updateContent(b.id, b.title);
    mirrorNow();
    autoSize(el, b, title);
  });
  title.addEventListener("blur", () => {
    const txt = getTitleText(title);
    const oldContent = title.dataset.oldContent || b.title;
    /* 空白内容块不保存：直接删除该块（含后端记录） */
    if (!txt.trim()) {
      const hadContent = (oldContent || "").trim().length > 0;
      if (hadContent && !confirm("内容块已被清空，确定删除？此操作不可撤销。")) {
        el.classList.remove("editing");
        title.contentEditable = "false";
        title.textContent = oldContent;
        b.title = oldContent;
        return;
      }
      el.classList.remove("editing");
      title.contentEditable = "false";
      removeBlock(b.id);
      return;
    }
    /* 便利贴夹：保留 ### 前缀；普通夹：纯文本 */
    const final = el.classList.contains("sticky")
      ? composeStickyContent(el.__parsedTitle || "", txt)
      : txt;
    b.title = final;
    title.textContent = txt;
    title.contentEditable = "false";
    el.classList.remove("editing");
    api.updateContent(b.id, final);
    /* 记录变更历史 */
    if (oldContent !== final) {
      api.saveTaskHistory(b.id, oldContent, final, "edit");
    }
    mirrorNow();
    autoSize(el, b, title);
  });
  title.addEventListener("keydown", e => {
    // 中文输入法组词阶段回车是"上屏"，不应作提交/换行处理
    if (e.isComposing) return;
    if (e.key === "Escape") { e.preventDefault(); title.blur(); return; }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); title.blur(); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      insertNewline(title);
    }
  });

  el.addEventListener("pointerdown", e => startDrag(e, el, b));
  el.addEventListener("click", e => {
    if (e.target.closest(".block-check") || e.target.closest(".block-del")) return;
    selectBlock(b.id);
  });
  return el;
}

function getTitleText(title) {
  let t = title.innerText;
  if (t == null) t = title.textContent;
  return t.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n+$/, "");
}

/* 在光标处插入换行（<br>），保证 contentEditable 内回车可用 */
function insertNewline(title) {
  let ok = false;
  try { ok = document.execCommand("insertLineBreak", false, null); } catch (_) {}
  if (!ok) {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && sel.getRangeAt(0).commonAncestorContainer.isConnected) {
      const rng = sel.getRangeAt(0);
      const br = document.createElement("br");
      rng.deleteContents();
      rng.insertNode(br);
      rng.setStartAfter(br); rng.setEndAfter(br);
      sel.removeAllRanges(); sel.addRange(rng);
    } else {
      const br = document.createElement("br");
      title.appendChild(br);
    }
  }
  requestAnimationFrame(() => autoSize(elFromTitle(title), blockFromTitle(title), title));
}

function elFromTitle(title) {
  let el = title.parentElement;
  while (el && !el.classList.contains("block")) el = el.parentElement;
  return el;
}
function blockFromTitle(title) {
  return (elFromTitle(title) || {}).__b || null;
}

function autoSize(el, b, title) {
  if (el.classList.contains("row")) return;
  requestAnimationFrame(() => {
    const w = Math.min(Math.max(title.scrollWidth + 46, 180), 510);
    el.style.minWidth = w + "px";
    b.w = w;
  });
}

/* ---------- 编辑态 ---------- */
function startEdit(el, b) {
  const title = el.querySelector(".block-title");
  title.dataset.oldContent = b.title;
  el.classList.add("editing");
  title.contentEditable = "true";
  title.focus();
  const r = document.createRange();
  r.selectNodeContents(title); r.collapse(false);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
}

/* ---------- 双击空白新建 ---------- */
canvas.addEventListener("dblclick", e => {
  if (e.target.closest(".block")) return;
  /* 便利贴夹：双击空白不新建便签，避免误触；用户按 Ctrl+Q 或工具栏「+」添加 */
  if (isStickyFolderActive()) return;
  const rect = board.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const clickY = e.clientY - rect.top;
  const dy = dividerY();
  const x = Math.max(16, Math.round(clickX));
  const y = clickY > dy + 24 ? Math.round(clickY) : Math.round(dy + 34);
  api.createTask(activeFolderId, "", x, y).then(nb => {
    nb.title = ""; // 新建时先显示空内容，直接编辑
    blocks.push(nb);
    renderAll();
    mirrorNow();
    const el = board.querySelector(`.block[data-id="${nb.id}"]`);
    if (el) startEdit(el, nb);
  });
});

/* ---------- Ctrl+V 直接粘贴到待完成区 ----------
   粘贴到画布空白处时，跳过「双击 → 空白 → 手动粘贴」流程，
   直接把剪贴板文本按行拆分成多个任务批量写入。
   编辑态（块标题内正在输入）由浏览器原生处理，不拦截。
   便利贴夹下不启用：粘贴便签走 Ctrl+Q 弹窗或工具栏「+」按钮，避免多行粘贴变成一堆便签。 */
canvas.addEventListener("paste", e => {
  const active = document.activeElement;
  if (active && (active.isContentEditable || /^(INPUT|TEXTAREA)$/.test(active.tagName))) return;
  if (e.target.closest('[contenteditable="true"], input, textarea')) return;
  if (stickyPopup && !stickyPopup.hidden) return;
  if (isStickyFolderActive()) return;
  const text = e.clipboardData && e.clipboardData.getData("text/plain");
  if (!text || !text.trim()) return;
  e.preventDefault();
  createTasksFromPaste(text, e.clientX, e.clientY);
});

async function createTasksFromPaste(text, clientX, clientY) {
  const lines = text.split(/\r?\n/).map(s => s.replace(/\s+$/,"")).filter(s => s.trim().length > 0);
  if (!lines.length) return;
  const rect = board.getBoundingClientRect();
  const dy = dividerY();
  const px = Math.max(16, Math.round(clientX - rect.left));
  // 若粘贴点在已完成区上方，强制落到待完成区顶端附近，避免覆盖已完成内容
  let py = Math.round(clientY - rect.top);
  if (py < dy + 24) py = dy + 24;
  const GAP = 62; // 估算每行块高度 + 间距
  const created = [];
  for (let i = 0; i < lines.length; i++) {
    const nb = await api.createTask(activeFolderId, lines[i], px, py + i * GAP);
    blocks.push(nb);
    created.push(nb);
  }
  renderAll();
  if (alignMode) alignPendingBlocks();
  mirrorNow();
  toast(lines.length > 1
    ? `已从剪贴板添加 ${lines.length} 个任务`
    : `已从剪贴板添加 1 个任务`);
}

/* ---------- 拖动 + 磁吸对齐 ---------- */
function startDrag(e, el, b) {
  /* 便利贴夹：块由 CSS Grid/Flex 排布，不允许用户拖动 */
  if (isStickyFolderActive()) return;
  if (e.target.closest(".block-check") || e.target.closest(".block-del")) return;
  if (e.button !== 0) return;

  // 编辑态下不启动拖动，允许用户自由选择文本
  const title = el.querySelector(".block-title");
  if (title && title.contentEditable === "true") return;
  if (el.classList.contains("editing")) return;
  const DRAG_THRESHOLD = 4;
  const originX = e.clientX, originY = e.clientY;
  let started = false;
  let raf = null, latestEv = null;
  let curX = b.x, curY = b.y;
  let startLeft = b.x, startTop = b.y;
  let elH = 0, boardRect = null, dY = dividerY();
  let xLines = [], yLines = [];
  let lastGuideV = null, lastGuideH = null;

  function beginDrag() {
    started = true;
    try { window.getSelection().removeAllRanges(); } catch (_) {}
    startLeft = b.x; startTop = b.y;
    curX = startLeft; curY = startTop;
    elH = el.offsetHeight;
    boardRect = board.getBoundingClientRect();
    xLines = [16];
    yLines = [dY, dY - elH];
    [...board.querySelectorAll(".block")].forEach(o => {
      if (o === el) return;
      const ox = parseFloat(o.style.left) || 0;
      const oy = parseFloat(o.style.top) || 0;
      const ow = o.offsetWidth, oh = o.offsetHeight;
      xLines.push(ox, ox + ow - el.offsetWidth);
      yLines.push(oy, oy - oh - 10, oy + oh + 10);
    });
    lastGuideV = null; lastGuideH = null;
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    el.classList.add("dragging");
    canvasWrap.classList.add("is-dragging");
    document.body.classList.add("is-dragging");
    document.body.style.cursor = "var(--cursor-grabbing)";
  }

  function applyFrame() {
    raf = null;
    if (!latestEv) return;
    const ev = latestEv;
    let nx = startLeft + (ev.clientX - originX);
    let ny = startTop + (ev.clientY - originY);
    // 拖动时不做网格磁吸（避免粘滞感），仅保留淡弱的边缘对齐
    const snap = snapFlat(nx, ny, xLines, yLines);
    if (snap.x !== null) nx = snap.x;
    if (snap.y !== null) ny = snap.y;
    nx = Math.max(8, nx);
    ny = Math.max(8, ny);
    el.style.transform = "translate3d(" + (nx - startLeft) + "px," + (ny - startTop) + "px,0)";
    curX = nx; curY = ny;
    if (snap.gx !== lastGuideV) {
      lastGuideV = snap.gx;
      if (snap.gx === null) { guideV.hidden = true; }
      else { guideV.hidden = false; guideV.style.left = snap.gx + "px"; }
    }
    if (snap.gy !== lastGuideH) {
      lastGuideH = snap.gy;
      if (snap.gy === null) { guideH.hidden = true; }
      else { guideH.hidden = false; guideH.style.top = snap.gy + "px"; }
    }
  }

  const onMove = ev => {
    if (!started) {
      if (Math.hypot(ev.clientX - originX, ev.clientY - originY) < DRAG_THRESHOLD) return;
      beginDrag();
    }
    latestEv = ev;
    if (raf === null) raf = requestAnimationFrame(applyFrame);
  };

  const onUp = () => {
    if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    if (!started) return;
    try { el.releasePointerCapture(e.pointerId); } catch (_) {}
    el.classList.remove("dragging");
    canvasWrap.classList.remove("is-dragging");
    document.body.classList.remove("is-dragging");
    el.style.transform = "";
    document.body.style.cursor = "";
    guideV.hidden = true; guideH.hidden = true;
    const moved = Math.abs(curX - startLeft) > 1 || Math.abs(curY - startTop) > 1;
    if (!moved) return;
    // 就地更新，不复建整块画布，避免释放时闪烁
    b.x = Math.round(curX); b.y = Math.round(curY);
    // 判定口径：块的「上沿」一跨过分界线就算已完成——向上拖时上沿最先越线，
    // 相当于「任意一点内容越过分界线即归入已完成」，不需要整块越过、也不需要
    // 拖到中心线以上（那是旧逻辑，导致必须拖到很上边才算数）
    const shouldDone = b.y < dividerY();
    if (shouldDone !== b.done) {
      b.done = shouldDone; b.row = shouldDone;
      // 拖入已完成区：记录本块，relayout 按 drop 位置决定插入索引（不再一律插顶）
      if (shouldDone) pendingInsert = b.id;
      api.toggleTask(b.id, shouldDone);
      // 完成区由 relayout 重新堆叠；放回待完成区则用 findFreeSpot 找不重叠的位置
      if (!shouldDone) findFreeSpot(b, dividerY());
      relayout(false);
      // 所有已完成块的堆叠位置都变了，必须全部落盘
      persistAllDonePositions();
      // 拖回待完成区的块自身坐标也要落盘
      if (!shouldDone) persistBlockPosition(b);
      mirrorNow();
    } else {
      // 状态没变：在当前区域内移动
      if (b.done) {
        // 已完成区域内拖动 → 切到自由排序，按拖动位置重排并落盘
        setDoneSortMode("manual");
        relayout(false);
        persistAllDonePositions();
      } else {
        // 待完成区域内拖动 → 只更新坐标
        api.moveTask(b.id, b.x, b.y);
        encodePos(el, b);
        // 重叠合并检测：拖到其他块上方时合并内容
        checkAndMerge(b, el);
      }
      mirrorNow();
    }
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

function snapFlat(nx, ny, xLines, yLines) {
  const S = 8;
  let sx = null, sy = null, gx = null, gy = null;
  let bestX = S, bestY = S;
  for (let i = 0; i < xLines.length; i++) {
    const d = Math.abs(nx - xLines[i]);
    if (d < bestX) { bestX = d; sx = xLines[i]; gx = xLines[i]; }
  }
  for (let i = 0; i < yLines.length; i++) {
    const d = Math.abs(ny - yLines[i]);
    if (d < bestY) { bestY = d; sy = yLines[i]; gy = yLines[i]; }
  }
  return { x: sx, y: sy, gx: gx, gy: gy };
}

/* ---------- 重叠合并 ---------- */
function checkAndMerge(b, el) {
  const curRect = { x: b.x, y: b.y, w: el.offsetWidth, h: el.offsetHeight };
  let target = null, targetEl = null;
  for (const o of blocks) {
    if (o.id === b.id) continue;
    const oEl = board.querySelector(`.block[data-id="${o.id}"]`);
    if (!oEl) continue;
    const oRect = { x: o.x, y: o.y, w: oEl.offsetWidth, h: oEl.offsetHeight };
    // 重叠面积 > 50% 视为合并
    const ox = Math.max(0, Math.min(curRect.x + curRect.w, oRect.x + oRect.w) - Math.max(curRect.x, oRect.x));
    const oy = Math.max(0, Math.min(curRect.y + curRect.h, oRect.y + oRect.h) - Math.max(curRect.y, oRect.y));
    const overlapArea = ox * oy;
    const selfArea = curRect.w * curRect.h;
    if (overlapArea / selfArea > 0.5) { target = o; targetEl = oEl; break; }
  }
  if (!target) return;
  const preview = target.title.length > 40 ? target.title.slice(0, 40) + "…" : target.title;
  if (!confirm(`确定将此任务合并到「${preview}」吗？\n合并后另一块将被删除，内容追加到目标块。`)) return;
  showMergeHint(el);
  const merged = (b.title + "\n" + target.title).trim();
  const oldTitle = target.title;
  api.updateContent(target.id, merged);
  target.title = merged;
  // 记录变更历史
  api.saveTaskHistory(target.id, oldTitle, merged, "merge");
  // 更新目标块 DOM 内容
  const targetTitleEl = targetEl.querySelector(".block-title");
  if (targetTitleEl) {
    targetTitleEl.textContent = merged;
    autoSize(targetEl, target, targetTitleEl);
  }
  // 删除被合并的块
  b.done = false;
  blocks = blocks.filter(x => x.id !== b.id);
  api.deleteTask(b.id);
  el.remove();
  if (b.id === selectedBlockId) clearSelection();
  relayout(false);
  mirrorNow();
}

function showMergeHint(el) {
  const hint = document.createElement("div");
  hint.className = "merge-hint";
  hint.textContent = "已合并内容";
  hint.style.left = (el.offsetLeft + el.offsetWidth / 2 - 40) + "px";
  hint.style.top = (el.offsetTop - 24) + "px";
  board.appendChild(hint);
  setTimeout(() => hint.remove(), 1200);
}

/* ---------- 任务操作 ---------- */
let selectedBlockId = null;
function clearSelection() {
  selectedBlockId = null;
  board.querySelectorAll(".block.selected").forEach(el => el.classList.remove("selected"));
}
function selectBlock(id) {
  clearSelection();
  selectedBlockId = id;
  const el = board.querySelector(`.block[data-id="${id}"]`);
  if (el) el.classList.add("selected");
}
async function copySelectedBlock() {
  if (selectedBlockId == null) return false;
  const b = blocks.find(x => x.id === selectedBlockId);
  if (!b) return false;
  const text = b.title || "";
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (_) {}
    ta.remove();
  }
  toast("已复制任务内容");
  return true;
}
function toggleDone(id) {
  const b = blocks.find(x => x.id === id);
  if (!b) return;
  const dy = dividerY();
  if (!b.done) {
    b.done = true; b.row = true; b.x = 20;
    // 自由排序模式下，新完成的块放在底部（给一个很大的 y，排序时自然垫底）
    if (getDoneSortMode() === "manual") b.y = 999999;
    api.toggleTask(id, true);
  } else {
    b.done = false; b.row = false;
    // 摆放前先把分界线算对：此刻 dividerY() 还包含本块的已完成高度（本块原先
    // 堆在已完成区底部，把分界线顶得很低），直接用它找空位会把块扔到很远下方、
    // 待完成区顶部留下一片空白。先按「本块已离开」的已完成内容算分界线再摆放。
    // b.done 刚置 false，layoutDoneRows 会自动排除本块，无需额外标记
    let newDy = defaultDividerY();
    const rows2 = layoutDoneRows(null);
    if (rows2.total) newDy = Math.max(defaultDividerY(), 14 + rows2.total + 46);
    findFreeSpot(b, newDy, true);
    api.toggleTask(id, false);
    api.moveTask(id, b.x, b.y);
  }
  relayout(false);
  persistAllDonePositions();
  mirrorNow();
}
function removeBlock(id) {
  blocks = blocks.filter(b => b.id !== id);
  api.deleteTask(id);
  const el = board.querySelector(`.block[data-id="${id}"]`);
  if (el) el.remove();
  if (id === selectedBlockId) clearSelection();
  relayout(false);
  mirrorNow();
}
async function removeFolder(id) {
  const f = folders.find(x => x.id === id);
  if (!f) return;
  if (isStickyFolder(f)) { alert("速记夹不可删除"); return; }
  if (!confirm(`确定删除任务夹「${f.name}」及其全部任务？`)) return;
  await api.deleteFolder(id);
  folders = folders.filter(x => x.id !== id);
  blocks = blocks.filter(b => b.folderId !== id);
  if (activeFolderId === id) activeFolderId = folders.length ? folders[0].id : null;
  if (!folders.length) {
    const nf = await api.createFolder("我的任务");
    folders.push(nf); activeFolderId = nf.id;
  }
  // 清理顺序表中已删除文件夹的残留记录
  const orderMap = getFolderOrderMap();
  delete orderMap[String(id)];
  saveFolderOrderMap(orderMap);
  await reloadTasks();
  renderAll();
}

/* ---------- 保存提示 ---------- */
function flashSave() {
  const old = folderMeta.textContent;
  folderMeta.textContent = "已自动保存 ✓";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { folderMeta.textContent = old; }, 600);
}

/* ---------- 持久化兜底镜像 ----------
 * 无论走 SQLite 还是 localStorage 分支，都额外在 localStorage 保存一份快照，
 * 防止任一存储层静默失败导致数据丢失；启动时若空数据则可恢复。 */
const MIRROR_KEY = "glassCanvas.backup.v1";
let mirrorTimer = null;
function mirrorNow() {
  clearTimeout(mirrorTimer);
  mirrorTimer = setTimeout(() => {
    try {
      const snap = {
        folders: folders.map(f => ({ id: f.id, name: f.name })),
        blocks: blocks.map(b => ({
          id: b.id, folderId: b.folderId, title: b.title,
          done: b.done, createdAt: b.createdAt, x: b.x, y: b.y,
        })),
        t: Date.now(),
      };
      localStorage.setItem(MIRROR_KEY, JSON.stringify(snap));
    } catch (_) {}
  }, 400);
}

async function restoreFromMirror() {
  try {
    const raw = localStorage.getItem(MIRROR_KEY);
    if (!raw) return;
    const snap = JSON.parse(raw);
    if (!snap.blocks || !snap.blocks.length) return;
    // 仅在当前任务夹没有数据时恢复，避免覆盖
    if (activeFolderId && blocks.length) return;
    for (const b of snap.blocks) {
      if (b.folderId !== activeFolderId) continue;
      const nb = await api.createTask(b.folderId, b.title || "", b.x || 16, b.y || 100);
      if (b.done) { await api.toggleTask(nb.id, true); nb.done = true; nb.row = true; }
      else await api.moveTask(nb.id, nb.x, nb.y);
      blocks.push(nb);
    }
    if (snap.blocks.length) renderAll();
  } catch (e) { console.error("[玻光画布] 恢复镜像失败", e); }
}

/* ---------- 弹窗 ---------- */
const modal = $("modal");
const nameInput = $("folder-name-input");
let modalMode = "create", modalTargetId = null;
function openModal(mode, folder) {
  modalMode = mode; modalTargetId = folder ? folder.id : null;
  $("modal-title").textContent = mode === "rename" ? "重命名任务夹" : "新建任务夹";
  nameInput.value = folder ? folder.name : "";
  modal.hidden = false; setTimeout(() => nameInput.focus(), 30);
}
function closeModal() { modal.hidden = true; }
$("new-folder-btn").addEventListener("click", () => openModal("create"));
$("modal-cancel").addEventListener("click", closeModal);
modal.addEventListener("click", e => { if (e.target === modal) closeModal(); });
$("modal-ok").addEventListener("click", async () => {
  const name = nameInput.value.trim();
  if (!name) { nameInput.focus(); return; }
  if (modalMode === "create") {
    const f = await api.createFolder(name);
    folders.push(f); activeFolderId = f.id;
  } else if (modalMode === "rename" && modalTargetId) {
    await api.renameFolder(modalTargetId, name);
    const f = folders.find(x => x.id === modalTargetId);
    if (f) f.name = name;
  }
  closeModal(); await reloadFolders(); await reloadTasks(); renderAll();
});
nameInput.addEventListener("keydown", e => { if (e.key === "Enter") $("modal-ok").click(); });

/* ---------- 设置 ---------- */
const SETTINGS_KEY = "glassCanvas.settings";
const settings = { cardActions: false };
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    settings.cardActions = !!s.cardActions;
  } catch {}
  applySettings();
}
function applySettings() {
  document.body.classList.toggle("show-card-actions", settings.cardActions);
  const cb = $("set-card-actions");
  if (cb) cb.checked = settings.cardActions;
  // 数据目录按钮仅桌面端可用；浏览器预览模式隐藏（避免误点）
  const dd = $("open-data-dir");
  if (dd) dd.hidden = !isTauri();
  // 更新相关按钮仅桌面端可用；浏览器预览模式隐藏
  const cu = $("check-update-btn");
  if (cu) cu.hidden = !isTauri();
  // 冷启动自动检查开关：默认开启
  const ua = $("update-auto");
  if (ua) ua.checked = localStorage.getItem("glassCanvas.update.auto") !== "0";
}
function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
const settingsModal = $("settings-modal");
$("settings-btn").addEventListener("click", () => {
  applySettings();
  settingsModal.hidden = false;
});
$("settings-ok").addEventListener("click", () => { settingsModal.hidden = true; });
settingsModal.addEventListener("click", e => { if (e.target === settingsModal) settingsModal.hidden = true; });
$("set-card-actions").addEventListener("change", e => {
  settings.cardActions = e.target.checked;
  applySettings(); saveSettings();
});
$("open-data-dir").addEventListener("click", async () => {
  const btn = $("open-data-dir");
  btn.disabled = true; btn.textContent = "打开中…";
  try {
    const path = await api.openDataDir();
    if (path) toast(`已打开数据目录：${path}`);
    else toast("浏览器预览模式下不支持打开数据目录");
  } catch (e) {
    console.error("[玻光画布] 打开数据目录失败", e);
    toast("打开数据目录失败，请检查路径权限。");
  } finally {
    btn.disabled = false; btn.textContent = "打开";
  }
});
loadSettings();

/* ---------- 自动更新 ----------
 * Tauri updater 插件：check() 取 latest.json → 对比当前版本 → 下载签名包 → install 触发安装器。
 * dialog=false，所以事件与回调都由我们自己处理；进度通过 onEvent 回调推 UI。
 * 浏览器预览模式（无 Tauri）不显示更新入口，check() 会抛错，兜底 toast。 */
const UPDATE_DISMISS_KEY = "glassCanvas.update.dismissed";
const UPDATE_AUTO_KEY = "glassCanvas.update.auto";
function updateVersion() {
  return "1.0.0";
}
async function fetchCurrentVersion() {
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch { return updateVersion(); }
}
/* 打开更新弹窗，传 update 对象。update.body 是 GitHub Release body（Markdown） */
function openUpdateModal(update, onProgress) {
  const m = $("update-modal");
  $("update-version").textContent = update.version;
  $("update-notes").textContent = update.body || "（此版本没有更新说明）";
  $("update-progress").classList.remove("show");
  $("update-cancel").hidden = false;
  $("update-install").hidden = false;
  $("update-install").textContent = "下载并安装";
  m.hidden = false;
  // 下载进度回调：onEvent({event:'Started'|'Progress'|'Finished', data:{contentLength?|chunkLength}})
  let total = 0, done = 0;
  onProgress = onProgress || (e => {
    if (e.event === "Started") {
      total = e.data.contentLength || 0;
      $("update-progress").classList.add("show");
      $("update-bar").style.width = "0%";
    } else if (e.event === "Progress") {
      done += e.data.chunkLength;
      if (total > 0) $("update-bar").style.width = Math.min(100, done * 100 / total) + "%";
      else $("update-bar").style.width = "100%";
    }
  });
  $("update-install").onclick = async () => {
    $("update-install").disabled = true;
    $("update-cancel").disabled = true;
    $("update-progress").classList.add("show");
    try {
      await update.downloadAndInstall(onProgress);
      // Windows 上 install 会自动启动安装器并退出应用，这里走不到
      // macOS/Linux 需要手动 relaunch
      if (navigator.userAgent.includes("Windows")) return;
      const { restart } = await import("@tauri-apps/plugin-process");
      await restart();
    } catch (err) {
      console.error("[玻光画布] 更新失败", err);
      toast("更新失败：" + (err.message || String(err)).slice(0, 60));
      $("update-install").disabled = false;
      $("update-cancel").disabled = false;
      $("update-progress").classList.remove("show");
    }
  };
}
function closeUpdateModal() { $("update-modal").hidden = true; }
$("update-cancel").addEventListener("click", closeUpdateModal);
$("update-dismiss").addEventListener("click", () => {
  localStorage.setItem(UPDATE_DISMISS_KEY, String(Date.now()));
  closeUpdateModal();
});
$("update-modal").addEventListener("click", e => { if (e.target === $("update-modal")) closeUpdateModal(); });

/* 检查更新：手动调用（设置页按钮）+ 冷启动自动检查。
 * 冷启动检查 24h 内已 dismiss 过则跳过。 */
async function checkForUpdates(silent) {
  if (!isTauri()) return;
  try {
    const update = await checkUpdate();
    if (!update) {
      if (!silent) toast("已是最新版本");
      return;
    }
    // 冷启动静默模式下：若 24h 内用户已点过「稍后」，就不再打扰
    if (silent) {
      const dismissed = Number(localStorage.getItem(UPDATE_DISMISS_KEY) || 0);
      if (Date.now() - dismissed < 24 * 3600 * 1000) return;
    }
    openUpdateModal(update);
  } catch (err) {
    console.warn("[玻光画布] 检查更新失败", err);
    if (!silent) toast("检查更新失败：" + (err.message || String(err)).slice(0, 60));
  }
}
/* 设置页：手动检查 + 显示当前版本 */
$("check-update-btn").addEventListener("click", async () => {
  const btn = $("check-update-btn");
  btn.disabled = true; btn.textContent = "检查中…";
  try { await checkForUpdates(false); }
  finally { btn.disabled = false; btn.textContent = "检查更新"; }
});
/* 冷启动自动检查开关：默认开启，关掉则持久禁用 */
$("update-auto").addEventListener("change", e => {
  localStorage.setItem(UPDATE_AUTO_KEY, e.target.checked ? "1" : "0");
  toast(e.target.checked ? "已开启冷启动自动检查" : "已关闭冷启动自动检查，仅手动触发");
});
/* 显示当前版本到设置页 */
fetchCurrentVersion().then(v => { $("app-version").textContent = "当前版本 v" + v; });
$("app-version").addEventListener("click", () => checkForUpdates(false));

/* ---------- 导出 / 导入 ---------- */
$("export-btn").addEventListener("click", () => {
  const data = {
    folders: folders.map(f => ({ ...f, blocks: blocks.filter(b => b.folderId === f.id) })),
    version: 1, exportedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "玻光画布备份-" + new Date().toISOString().slice(0, 10) + ".json";
  a.click(); URL.revokeObjectURL(a.href);
});
$("import-btn").addEventListener("click", () => $("import-file").click());
$("import-file").addEventListener("change", async e => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data.folders) throw new Error("格式错误");
      if (!confirm("导入将覆盖当前所有数据，确定继续？")) return;
      // 先删除旧数据
      for (const f of folders) await api.deleteFolder(f.id);
      folders = []; blocks = [];
      for (const f of data.folders) {
        const nf = await api.createFolder(f.name);
        if (f.dividerY) setDividerY(nf.id, f.dividerY);
        const oldBlocks = f.blocks || [];
        for (const b of oldBlocks) {
          const nb = await api.createTask(nf.id, b.title || "", b.x || 16, b.y || 100);
          if (b.done) { await api.toggleTask(nb.id, true); nb.done = true; nb.row = true; }
          blocks.push(nb);
        }
        folders.push({ ...nf, dividerY: getDividerY(nf.id) });
      }
      if (folders.length) activeFolderId = folders[0].id;
      await reloadFolders(); await reloadTasks(); renderAll();
    } catch (err) { alert("导入失败：" + err.message); }
  };
  reader.readAsText(file); e.target.value = "";
});

/* ---------- 滚动位置记忆 ----------
   按任务夹 ID 独立记住离开时的滚动位置；找不到记录时回到 (0,0)，
   避免沿用上一个任务夹的 y 值被浏览器 clamp 到新任务夹底部。 */
function _scrollMap() {
  try { return JSON.parse(localStorage.getItem(SCROLL_KEY) || "{}"); }
  catch { return {}; }
}
function saveScroll() {
  if (activeFolderId == null) return;
  try {
    const map = _scrollMap();
    map[String(activeFolderId)] = { x: canvas.scrollLeft, y: canvas.scrollTop };
    localStorage.setItem(SCROLL_KEY, JSON.stringify(map));
  } catch {}
}
function restoreScroll() {
  if (activeFolderId == null) return;
  try {
    const map = _scrollMap();
    const s = map[String(activeFolderId)] || { x: 0, y: 0 };
    canvas.scrollLeft = s.x || 0;
    canvas.scrollTop = s.y || 0;
  } catch {
    canvas.scrollLeft = 0; canvas.scrollTop = 0;
  }
}
canvas.addEventListener("scroll", () => {
  clearTimeout(canvas._t);
  canvas._t = setTimeout(saveScroll, 200);
});
window.addEventListener("resize", () => renderAll());

/* ---------- 数据加载 ---------- */
async function reloadFolders() {
  folders = await api.getFolders();
  if (!folders.length) {
    const f = await api.createFolder("我的任务");
    folders = [f];
  }
  if (!activeFolderId || !folders.find(x => x.id === activeFolderId)) {
    const defId = getDefaultFolderId();
    activeFolderId = (defId && folders.find(x => x.id === defId))
      ? defId : folders[0].id;
  }
}
/* 切换到指定任务夹并重新加载其任务（避免串夹显示错误数据） */
async function selectFolder(id) {
  if (activeFolderId === id && blocks.some(b => b.folderId === id)) return;
  clearSelection();
  // 必须先保存当前文件夹的滚动位置，再切换 activeFolderId。
  // saveScroll 内部用 activeFolderId 作为 key，顺序颠倒会把旧文件夹的位置
  // 覆盖写到新文件夹的记录里，导致切过去仍停在旧文件夹的位置。
  saveScroll();
  activeFolderId = id;
  alignMode = false;
  savedPositions = {};
  alignToggle.checked = false;
  await reloadTasks();
  renderAll();
}
async function reloadTasks() {
  if (!activeFolderId) { blocks = []; return; }
  blocks = await api.getTasks(activeFolderId);
  // 迁移旧数据（普通任务夹：块初始位置可能是 (0,0)，需要按栅格摆放）
  // 便利贴夹不需要位置信息（由 CSS Grid 自动排布），跳过迁移避免多余写入
  const isSticky = isStickyFolderActive();
  const allZero = blocks.length > 0 && blocks.every(b => b.x === 0 && b.y === 0);
  if (allZero && !isSticky) {
    const dy = dividerY();
    const jobs = blocks.map((b, i) => {
      b.x = 20 + (i % 4) * 200;
      b.y = dy + 20 + Math.floor(i / 4) * 80;
      return api.moveTask(b.id, b.x, b.y);
    });
    await Promise.all(jobs);
  }
}

/* ---------- 选中 / 复制快捷键 ---------- */
canvas.addEventListener("click", e => {
  if (!e.target.closest(".block")) clearSelection();
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape") { clearSelection(); closeStickyPopup(); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) {
    const ae = document.activeElement;
    if (ae && (ae.isContentEditable || ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) return;
    if (selectedBlockId == null) return;
    e.preventDefault();
    copySelectedBlock();
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === "q" || e.key === "Q")) {
    e.preventDefault();
    toggleStickyPopup();
  }
});

/* ---------- 速记夹弹窗 ---------- */
function toggleStickyPopup() {
  if (stickyPopup.hidden) showStickyPopup();
  else closeStickyPopup();
}
function showStickyPopup() {
  const rect = canvas.getBoundingClientRect();
  stickyPopup.style.left = (window.innerWidth / 2 - 150) + "px";
  stickyPopup.style.top = (window.innerHeight / 2 - 100) + "px";
  stickyPopup.hidden = false;
  stickyTitle.value = "";
  stickyInput.value = "";
  stickyTitle.focus();
}
function closeStickyPopup() {
  stickyPopup.hidden = true;
  stickyTitle.value = "";
  stickyInput.value = "";
}
async function saveStickyNote() {
  const titleTxt = stickyTitle.value.trim();
  const bodyTxt = stickyInput.value.trim();
  /* 标题与正文均可为空，但至少一项需要非空 */
  if (!titleTxt && !bodyTxt) { closeStickyPopup(); return; }
  let fid = stickyFolderId;
  if (!fid || !folders.find(f => f.id === fid)) {
    fid = await ensureStickyFolder();
  }
  /* 用 "### 标题\n\n正文" 约定写入 content（标题可省略） */
  const content = composeStickyContent(titleTxt, bodyTxt);
  /* 初始位置用中性值 (16, 0)：便利贴夹下由 CSS Grid 自动排布，
   * 不需要像普通任务夹那样依赖 dividerY/findFreeSpot。 */
  const nb = await api.createTask(fid, content, 16, 0);

  const prevFolderId = activeFolderId;
  const needSwitch = prevFolderId !== fid;

  if (needSwitch) {
    saveScroll();
    activeFolderId = fid;
    await reloadTasks();
  } else {
    nb.done = false; nb.row = false;
    blocks.push(nb);
  }
  renderAll();

  if (needSwitch) {
    /* 切回原文件夹：用户本来就在别的任务夹里按的 Ctrl+Q，不该被带过去 */
    saveScroll();
    activeFolderId = prevFolderId;
    await reloadTasks();
    renderAll();
  }
  closeStickyPopup();
  flashSave();
  mirrorNow();
}

/* ---------- 确保速记夹存在 ---------- */
async function ensureStickyFolder() {
  const existing = folders.find(f => isStickyFolder(f));
  if (existing) {
    if (existing.name !== STICKY_FOLDER) {
      await api.renameFolder(existing.id, STICKY_FOLDER);
      existing.name = STICKY_FOLDER;
    }
    stickyFolderId = existing.id;
    return existing.id;
  }
  const nf = await api.createFolder(STICKY_FOLDER);
  folders.push(nf);
  stickyFolderId = nf.id;
  return nf.id;
}

/* ---------- 应用标题（可自定义） ---------- */
function applyAppTitle(text) {
  if (!brandTitleEl) return;
  brandTitleEl.textContent = text;
  document.title = text + " · 任务管理";
}
function bindBrandTitle() {
  if (!brandTitleEl || brandTitleEl.__bound) return;
  brandTitleEl.__bound = true;
  brandTitleEl.addEventListener("dblclick", e => {
    e.preventDefault();
    e.stopPropagation();
    brandTitleEl.contentEditable = "true";
    brandTitleEl.spellcheck = false;
    brandTitleEl.dataset.oldContent = brandTitleEl.textContent;
    brandTitleEl.classList.add("editing");
    brandTitleEl.focus();
    const r = document.createRange();
    r.selectNodeContents(brandTitleEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  });
  brandTitleEl.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); brandTitleEl.blur(); return; }
    if (e.key === "Escape") {
      e.preventDefault();
      brandTitleEl.textContent = brandTitleEl.dataset.oldContent || APP_TITLE_DEFAULT;
      brandTitleEl.contentEditable = "false";
      brandTitleEl.classList.remove("editing");
      applyAppTitle(brandTitleEl.textContent);
      brandTitleEl.focus();
      return;
    }
    if (brandTitleEl.textContent.length >= APP_TITLE_MAX &&
        !e.ctrlKey && !e.metaKey &&
        !["Backspace", "Delete", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
      e.preventDefault();
    }
  });
  brandTitleEl.addEventListener("blur", () => {
    if (brandTitleEl.contentEditable !== "true") return;
    const prev = brandTitleEl.dataset.oldContent;
    let next = brandTitleEl.textContent.replace(/\s+/g, " ").trim().slice(0, APP_TITLE_MAX);
    if (!next) next = prev || APP_TITLE_DEFAULT;
    brandTitleEl.contentEditable = "false";
    brandTitleEl.classList.remove("editing");
    if (next !== prev) {
      const saved = setAppTitle(next);
      applyAppTitle(saved);
      toast(`应用名称已改为「${saved}」`);
    } else {
      applyAppTitle(next);
    }
    delete brandTitleEl.dataset.oldContent;
  });
}

/* ---------- 事件绑定 ---------- */
function bindStickyEvents() {
  $("sticky-save").addEventListener("click", saveStickyNote);
  $("sticky-cancel").addEventListener("click", closeStickyPopup);
  stickyInput.addEventListener("keydown", e => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveStickyNote(); }
    if (e.key === "Escape") { e.stopPropagation(); closeStickyPopup(); }
  });
  /* 标题 Enter 跳到正文；Escape 关闭 */
  if (stickyTitle) {
    stickyTitle.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); stickyInput.focus(); return; }
      if (e.key === "Escape") { e.stopPropagation(); closeStickyPopup(); }
    });
  }
  bindStickyHeaderEvents();
}

/* 便利贴 header 事件：视图切换 / 搜索 / 新建按钮 */
function bindStickyHeaderEvents() {
  if (viewWallBtn && viewListBtn) {
    const setMode = (m) => {
      stickyViewMode = m;
      try { localStorage.setItem(STICKY_VIEW_KEY, m); } catch {}
      applyStickyLayout();
      applyStickySearch();
      renderStickyHeader();
    };
    viewWallBtn.addEventListener("click", () => setMode("wall"));
    viewListBtn.addEventListener("click", () => setMode("list"));
  }
  if (stickySearchInput) {
    stickySearchInput.addEventListener("input", () => {
      stickyQuery = stickySearchInput.value;
      applyStickySearch();
      renderStickyHeader();
    });
    stickySearchInput.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        e.preventDefault();
        stickySearchInput.value = "";
        stickyQuery = "";
        applyStickySearch();
        renderStickyHeader();
      }
    });
  }
  if (stickySearchClear) {
    stickySearchClear.addEventListener("click", () => {
      stickySearchInput.value = "";
      stickyQuery = "";
      applyStickySearch();
      renderStickyHeader();
      stickySearchInput.focus();
    });
  }
  if (stickyAddBtn) {
    stickyAddBtn.addEventListener("click", () => showStickyPopup());
  }
}

/* ---------- 启动 ---------- */
async function boot() {
  // 桌面端 IPC 注入是异步的，最多等 800ms 再决定走 SQLite 还是 localStorage
  if (!isTauri()) {
    const deadline = Date.now() + 800;
    while (!isTauri() && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 30));
    }
  }
  const mode = isTauri() ? "Tauri / SQLite" : "浏览器 / localStorage";
  console.info("[玻光画布] 运行模式:", mode);
  renderFolders();
  applyAppTitle(getAppTitle());
  bindBrandTitle();
  if (isTauri()) {
    try { console.info("[玻光画布] 存储信息:", await invoke("storage_info")); }
    catch (e) { console.error("[玻光画布] 获取存储信息失败", e); }
    // 上一次会话若降级过，localStorage 里可能留有孤儿数据；IPC 可用后立即回灌
    await migrateOrphansToSqlite();
  }
  await reloadFolders();
  await ensureStickyFolder();
  await reloadTasks();
  await restoreFromMirror();
  renderAll();
  // 绑定速记夹按钮
  bindStickyEvents();
  alignToggle.addEventListener("change", () => {
    alignMode = alignToggle.checked;
    if (alignMode) alignPendingBlocks();
    else restorePendingBlocks();
  });
  // 冷启动检查更新：延后 1.5s，避免与初始化抢带宽；用户关掉自动检查则跳过
  if (isTauri() && localStorage.getItem(UPDATE_AUTO_KEY) !== "0") {
    setTimeout(() => checkForUpdates(true), 1500);
  }
  // 窗口关闭前保存滚动位置
  window.addEventListener("beforeunload", saveScroll);
}
boot();
