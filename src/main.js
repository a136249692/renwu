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
    let list = (d.tasks || []).filter(t => t.folder_id === folderId);
    // 便利贴夹在浏览器兜底模式下按 sort_order 排序（拖放持久化依赖它）
    const f = folders.find(x => x.id === folderId);
    if (f && isStickyFolder(f) && list.length > 1) {
      list = list.slice().sort((a, b) => {
        const sa = Number(a.sort_order) || 0, sb = Number(b.sort_order) || 0;
        if (sa !== sb) return sa - sb;
        return (Number(a.created_at) || 0) - (Number(b.created_at) || 0);
      });
    }
    return list.map(mapTask);
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
  /* 把任务跨任务夹迁移：在目标夹里新建一条相同内容的任务，删除源夹原记录。
   * 保留 folder_id / x / y / is_completed / sort_order；仅 content / 归属夹变化。
   * 之所以用「新建+删除」而不是 update，是因为 update_task_position 等 Tauri 命令
   * 只按 id 更新单个字段，没有 update_task_folder；走两步骤在两套存储里最省事，
   * 也不需要改 Rust 侧 schema。
   *
   * 源任务读取顺序：
   *   1) 内存 blocks（最快，桌面/浏览器都有）
   *   2) 后端 get_tasks（桌面端专用，兜底「切换夹后 blocks 未包含目标 id」的极端情况）
   *   3) localStorage mirror（浏览器预览或历史遗留数据）
   * 打包后 isTauri()=true 且 localStorage 无 glassCanvas.v1 数据，因此必须走前两条。 */
  async moveTaskToFolder(id, targetFolderId) {
    let src = null;
    // 1) 内存 blocks
    const memB = blocks.find(t => Number(t.id) === Number(id));
    if (memB && Number(memB.folderId) !== Number(targetFolderId)) {
      src = {
        id: memB.id, folder_id: memB.folderId,
        content: memB.title || "",
        is_completed: memB.done ? 1 : 0,
        sort_order: memB.sort_order || 0,
        x: memB.x ?? 16, y: memB.y ?? 0,
      };
    }
    // 2) 后端：按 id 从所有 folder 中查（get_tasks 只按夹查，故需先扫所有夹）
    if (!src && isTauri()) {
      for (const f of folders) {
        if (Number(f.id) === Number(targetFolderId)) continue;
        const list = await invoke("get_tasks", { folderId: f.id });
        if (!list || !list.length) continue;
        const t = list.find(x => Number(x.id) === Number(id));
        if (t) {
          src = {
            id: t.id, folder_id: t.folder_id,
            content: t.content || "",
            is_completed: t.is_completed ? 1 : 0,
            sort_order: t.sort_order || 0,
            x: t.x ?? 16, y: t.y ?? 0,
          };
          break;
        }
      }
    }
    // 3) localStorage 兜底
    if (!src) {
      const d = lsLoadAll();
      const found = (d.tasks || []).find(t => Number(t.id) === Number(id));
      if (found) src = found;
    }
    if (!src || Number(src.folder_id) === Number(targetFolderId)) return null;
    if (isTauri()) {
      const nb = await invoke("create_task", {
        folderId: targetFolderId,
        content: src.content || "",
        positionX: src.x ?? 16,
        positionY: src.y ?? 0,
      });
      await invoke("delete_task", { id: src.id });
      return nb ? mapTask(nb) : null;
    }
    const d = lsLoadAll();
    const nt = {
      id: nextMockId(),
      folder_id: targetFolderId,
      content: src.content || "",
      is_completed: src.is_completed ? 1 : 0,
      created_at: Date.now(),
      sort_order: src.sort_order || 0,
      x: src.x ?? 16,
      y: src.y ?? 0,
    };
    d.tasks = (d.tasks || []).filter(t => Number(t.id) !== Number(src.id));
    d.tasks.push(nt);
    lsSaveAll(d);
    return mapTask(nt);
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
  /* 便利贴夹：把当前夹内便签按 ids 的顺序写入持久层。
   * Tauri: 调 reorder_tasks 一次性把 sort_order 更新为 1..N。
   * 浏览器: 更新 localStorage 里的 sort_order（getTasks 用同值兜底，
   *          DB 端 ORDER BY 已含 created_at/ID，但这里显式写值保持一致）。 */
  async reorderSticky(ids) {
    if (!ids || !ids.length) return;
    if (isTauri()) {
      const n = await invoke("reorder_tasks", { ids });
      return n === null ? null : n;
    }
    const d = lsLoadAll();
    const idx = new Map(ids.map((id, i) => [id, i + 1]));
    for (const t of d.tasks || []) {
      if (t.folder_id !== activeFolderId) continue;
      if (idx.has(t.id)) t.sort_order = idx.get(t.id);
    }
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
const ALIGN_KEY = "glassCanvas.alignModeByFolder";
function loadAlignMap() {
  try {
    const raw = localStorage.getItem(ALIGN_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw);
    return p && typeof p === "object" ? p : {};
  } catch { return {}; }
}
function getAlignMode(folderId) {
  const map = loadAlignMap();
  return !!map[String(folderId)];
}
function saveAlignMode(folderId, val) {
  try {
    const map = loadAlignMap();
    if (val) map[String(folderId)] = 1;
    else delete map[String(folderId)];
    localStorage.setItem(ALIGN_KEY, JSON.stringify(map));
  } catch {}
}

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
/* 任务夹 pointer 排序的私有状态（与 _dragFolderId 区分：后者保留给便签块跨夹） */
let _foldDragSrc = null;
let _foldDragSuppressed = false;

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

/* ---------- 待完成块靠左对齐 / 恢复原位 ----------
   appendIds：本轮需要追加到栈底的新块 id 数组（新建、跨夹迁入等）。
   - 传 [] 或 null：按「当前 y 升序」重排——保留用户在勾选前手动摆放的视觉顺序；
     首次勾选对齐、勾选/取消勾选、跨区拖动、删除合并等场景都走这条路径。
   - 传非空数组：旧块按当前 y 升序排列（保持视觉顺序不变），新块统一追加到最下边行，
     实现「输入内容后自动追加到最下边行」。
   首次调用（savedPositions 为空）会把当前坐标缓存下来，取消勾选时可以还原。 */
function alignPendingBlocks(appendIds) {
  // 处于「放大编辑」态的块不能参与重排——重排会写 b.x/b.y，
  // 退出放大后坐标就是错的（CSS 放大态下 b.x/b.y 是无效的，
  // 因为 position: fixed 用 left/top: 5% 覆盖，退出后应恢复到原位置）。
  const pending = blocks.filter(b => {
    if (b.done) return false;
    const el = board.querySelector(`.block[data-id="${b.id}"]`);
    return el ? !el.classList.contains("zoomed") : true;
  });
  if (!pending.length) return;
  if (Object.keys(savedPositions).length === 0) {
    savedPositions = {};
    pending.forEach(b => { savedPositions[b.id] = { x: b.x, y: b.y }; });
  }
  const newSet = new Set(appendIds || []);
  // 旧块按当前 y 升序（视觉顺序），新块统一追加到底部
  pending.sort((a, b) => {
    const aIsNew = newSet.has(a.id), bIsNew = newSet.has(b.id);
    if (aIsNew !== bIsNew) return aIsNew ? 1 : -1;
    if (aIsNew && bIsNew) {
      return ((a.createdAt || 0) - (b.createdAt || 0)) || (a.id - b.id);
    }
    return (a.y || 0) - (b.y || 0);
  });
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
  // 与 relayout 保持一致：额外追加 CANVAS_BOTTOM_PAD 的空白区，
  // 保证靠左对齐后待完成区下方仍有可滚动的留白（否则对齐后画布会被压到视口高，
  // 用户就看不到「未勾选状态」下那块底部空白）
  // 注意：必须先用原始 canvas 高度做基准，否则下面 style.height 一改，
  // canvas.clientHeight 会跟着变化（feedback loop），下一轮 relayout 用
  // 新高度会越叠越厚
  const originalVpH = canvas.clientHeight;
  board.style.height = Math.max(maxY + CANVAS_BOTTOM_PAD, originalVpH) + "px";
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
    li.innerHTML = `${handleHtml}<span class="ico">📁</span><span class="name"></span><span class="cnt"></span>${starHtml}${locked ? '<span class="lock-icon">🔒</span>' : ''}<button class="rm" title="删除任务夹">×</button>`;
    li.querySelector(".name").textContent = f.name;
    // 待完成数量 = 总数 - 已完成数。
    // Tauri: get_folders SQL 里已聚合 total/completed。
    // 浏览器: localStorage 的 folders 不随任务变动，直接从 d.tasks 现算，
    //         保证新建/删除/勾选任务后侧栏数量立即正确。
    let pendingCount = (Number(f.total) || 0) - (Number(f.completed) || 0);
    if (!isTauri()) {
      const d = lsLoadAll();
      const fs = (d.tasks || []).filter(t => t.folder_id === f.id);
      pendingCount = fs.filter(t => !t.is_completed).length;
    }
    if (pendingCount > 0) li.querySelector(".cnt").textContent = String(pendingCount);
    li.addEventListener("click", e => {
      if (e.target.classList.contains("rm") || e.target.classList.contains("star-btn")) return;
      if (_foldDragSuppressed) { _foldDragSuppressed = false; return; }
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
    // 拖动排序：只有非速记夹可以拖动（作为拖源）。
    // 用 pointerdown+pointermove+pointerup 实现，不用 HTML5 DnD——后者在打包后
    // Windows WebView2 里对侧栏 li 作为拖源不稳定（浏览器预览正常）。
    if (!locked) {
      li.addEventListener("pointerdown", e => {
        if (e.button !== 0) return;
        if (e.target.closest(".rm") || e.target.closest(".star-btn")) return;
        startFolderPointerDrag(e, f.id, li);
      });
    }
    // 拖入目标：所有任务夹都可以作为 drop target（含速记夹），
    // 用来接收从便签墙 HTML5 DnD 拖过来的块
    li.addEventListener("dragover", e => {
      // 文件夹重排：只有正在拖文件夹时才算
      if (_dragFolderId !== null) {
        e.preventDefault();
        _dragLastX = e.clientX;
        _dragLastY = e.clientY;
        if (li.dataset.id !== String(_dragFolderId)) li.classList.add("drag-over");
        else li.classList.remove("drag-over");
        return;
      }
      // 便签块跨夹移动：仅在正从便签墙拖便签块时算
      if (_stickyDragEl) {
        e.preventDefault();
        try { e.dataTransfer.dropEffect = "move"; } catch (_) {}
        if (li.dataset.id !== String(activeFolderId)) li.classList.add("block-move-target");
        else li.classList.remove("block-move-target");
      }
    });
    li.addEventListener("dragleave", () => {
      li.classList.remove("drag-over");
      li.classList.remove("block-move-target");
    });
    li.addEventListener("drop", e => {
      e.preventDefault();
      li.classList.remove("drag-over");
      li.classList.remove("block-move-target");
      // 便签块跨夹移动
      if (_stickyDragEl) {
        const dragEl = _stickyDragEl;
        const dragId = Number(dragEl.dataset.id);
        const targetId = Number(li.dataset.id);
        _stickyDragEl = null;
        dragEl.classList.remove("block-dragging");
        board.querySelectorAll(".block.sticky.block-drop-target").forEach(n => n.classList.remove("block-drop-target"));
        if (targetId === Number(activeFolderId)) return;
        const b = blocks.find(x => x.id === dragId);
        if (b) handleCrossFolderDrop(targetId, dragEl, b);
        return;
      }
      // 文件夹重排
      if (_dragFolderId === null) return;
      const targetId = Number(li.dataset.id);
      if (targetId === _dragFolderId) return;
      reorderFolders(_dragFolderId, targetId);
    });
    folderListEl.appendChild(li);
  });
}

/* 局部刷新侧栏某一任务夹的「待完成数量」数字。
   勾选完成、删除、合并、拖动跨分界线等操作都会改变 pending 数，
   但它们只走 relayout() 不刷新侧栏，导致任务夹上的数字"卡住"。
   这里只改 .cnt 的 textContent，不重绘整栏，避免闪烁和焦点丢失。

   数据源：
   - 当前文件夹：用内存 blocks（最新，不受持久化防抖影响）
   - 其他文件夹：从 localStorage mirror 快照算（可能滞后 ~400ms；
     跨夹移动的路径（handleCrossFolderDrop）本就会调 renderFolders()
     做全量刷新，所以这个降级路径只处理「切夹后再切回来」的短暂窗口）

   桌面端额外在后台 reloadFolders() 让 SQLite 里的 folders.total/
   completed 追上真实值，为下次 renderFolders() 备用。 */
let _folderCountTimer = null;
function updateFolderCount(folderId) {
  if (folderId == null) return;
  const li = folderListEl.querySelector(`.folder-item[data-id="${folderId}"]`);
  if (!li) return;
  const cntEl = li.querySelector(".cnt");
  if (!cntEl) return;

  let pending;
  if (Number(folderId) === Number(activeFolderId)) {
    // 当前夹：内存 blocks 是最新的（勾选/删除/合并/拖过分界线都已同步到 b.done）
    pending = blocks.filter(b => !b.done).length;
  } else if (isTauri()) {
    // Tauri 桌面端：其他夹的实时计数从后端拉。
    // 之前的实现走 localStorage mirror，打包后 localStorage 里根本没有 glassCanvas.v1 数据，
    // 结果任何非当前夹的计数刷新都算成 0——所以侧栏「待完成 N」徽章在跨夹拖动后卡住不动。
    const f = folders.find(x => Number(x.id) === Number(folderId));
    pending = f ? Math.max(0, (Number(f.total) || 0) - (Number(f.completed) || 0)) : 0;
  } else {
    // 浏览器预览：localStorage 是唯一数据源，直接从 d.tasks 现算
    const d = lsLoadAll();
    const fs = (d.tasks || []).filter(t => t.folder_id === folderId);
    pending = fs.filter(t => !t.is_completed).length;
  }

  if (pending > 0) cntEl.textContent = String(pending);
  else cntEl.textContent = "";

  // 桌面端：让内存里的 folders.total/completed 追上 SQLite，供下次 renderFolders 使用
  // （否则下一次 renderFolders 会拿到旧的 total/completed 覆盖刚写入的正确值）
  if (isTauri()) {
    clearTimeout(_folderCountTimer);
    _folderCountTimer = setTimeout(() => { reloadFolders().catch(() => {}); }, 500);
  }
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

/* 任务夹 pointer 排序：用 pointerdown+setPointerCapture+window pointermove/pointerup，
   替代 HTML5 DnD。HTML5 DnD 在 WebView2 打包后侧栏 li 作为拖源不稳定；
   pointer 模式跟普通块 startDrag 一致，跨夹移动那块也证明它在 WebView2 里稳定。
   交互细节：
   - 拖动前 4px 阈值内不当拖动，仅当 pointermove 超过阈值才激活拖拽视觉；
   - 移动时用 elementFromPoint 命中最近的 .folder-item，按鼠标相对中线挂
     fold-drop-before / fold-drop-after class 显示插入指示线；
   - 松手时按当前 hover 目标调用 reorderFolders(srcId, targetId, before?)。 */
function startFolderPointerDrag(e, srcId, srcEl) {
  if (_foldDragSrc != null) return;
  e.preventDefault();
  const startX = e.clientX, startY = e.clientY;
  const startElt = e.target;
  const startElRect = srcEl.getBoundingClientRect();
  let activated = false;

  try { startElt.setPointerCapture(e.pointerId); } catch (_) {}

  const onMove = (ev) => {
    const dx = ev.clientX - startX, dy = ev.clientY - startY;
    if (!activated) {
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      activated = true;
      _foldDragSrc = srcId;
      _foldDragSrcEl = srcEl;
      srcEl.classList.add("fold-dragging");
      folderListEl.classList.add("reordering");
      _dragLastX = ev.clientX;
      _dragLastY = ev.clientY;
    }
    ev.preventDefault();
    _dragLastX = ev.clientX;
    _dragLastY = ev.clientY;
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const tgt = el ? el.classList.contains("folder-item") ? el : el.closest(".folder-item") : null;
    folderListEl.querySelectorAll(".fold-drop-before,.fold-drop-after").forEach(x => {
      x.classList.remove("fold-drop-before"); x.classList.remove("fold-drop-after");
    });
    if (!tgt || Number(tgt.dataset.id) === Number(srcId)) return;
    if (tgt.classList.contains("locked")) return;
    const r = tgt.getBoundingClientRect();
    const isVertical = getComputedStyle(folderListEl).flexDirection !== "row";
    const pastMid = isVertical
      ? (ev.clientY > r.top + r.height / 2)
      : (ev.clientX > r.left + r.width / 2);
    tgt.classList.add(pastMid ? "fold-drop-after" : "fold-drop-before");
  };

  const onUp = (ev) => {
    try { startElt.releasePointerCapture(e.pointerId); } catch (_) {}
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const tgt = activated && el ? (el.classList.contains("folder-item") ? el : el.closest(".folder-item")) : null;
    const tgtId = tgt ? Number(tgt.dataset.id) : null;
    const wasDragging = activated;
    srcEl.classList.remove("fold-dragging");
    folderListEl.classList.remove("reordering");
    folderListEl.querySelectorAll(".fold-drop-before,.fold-drop-after").forEach(x => {
      x.classList.remove("fold-drop-before"); x.classList.remove("fold-drop-after");
    });
    _foldDragSrc = null;
    _foldDragSrcEl = null;
    _foldDragMoveHandler = null;
    _foldDragUpHandler = null;
    if (wasDragging) {
      _foldDragSuppressed = true;
      if (tgtId != null && tgtId !== Number(srcId)) reorderFolders(srcId, tgtId);
    }
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
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

/* 便利贴夹：当前正在拖动的块元素（模块级引用，跨元素访问用） */
let _stickyDragEl = null;

/* 便利贴夹：允许拖到 board 空白区域——放到末尾。
 * 单个块的 dragover/drop 会优先命中；这里只在没有拖目标时生效。 */
if (!board.__stickyDropBound) {
  board.__stickyDropBound = true;
  board.addEventListener("dragover", e => {
    if (!_stickyDragEl) return;
    if (e.target !== board && !e.target.classList.contains("board-empty")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  });
  board.addEventListener("drop", e => {
    if (!_stickyDragEl) return;
    if (e.target !== board && !e.target.classList.contains("board-empty")) return;
    e.preventDefault();
    board.appendChild(_stickyDragEl);
    applyStickyLayout();
    persistStickyOrder();
  });
}

/* 跨任务夹移动：把 el/b 所属的内容块从 activeFolder 迁到 targetFolderId。
 * 触发来源有两个：
 *   1) 普通夹里的 pointerdown 拖动 → 松手时悬停在侧栏任务夹上；
 *   2) 速记夹里的 HTML5 DnD 拖拽 → 松手时拖到侧栏任务夹上。
 * 语义：目标夹新建一条相同内容的记录（保留原 x/y/is_completed/sort_order），
 *       删除源夹原记录。若目标夹是速记夹，把 body 拼回 "### 标题\n\n正文" 形式；
 *       若源夹是速记夹而目标是普通夹，把 "### 标题\n\n正文" 拼回单行。 */
async function handleCrossFolderDrop(targetFolderId, el, b) {
  if (Number(targetFolderId) === Number(activeFolderId)) { flashSave(); return; }
  const target = folders.find(f => Number(f.id) === Number(targetFolderId));
  if (!target) return;
  const srcContent = b.title || "";
  let destTitle;
  const srcIsSticky = isStickyFolderActive();
  const dstIsSticky = isStickyFolder(target);
  if (dstIsSticky) {
    // 目标是速记夹：需要 "### 标题\n\n正文" 约定
    if (srcIsSticky) {
      // 速记夹→速记夹：原样搬入
      destTitle = srcContent;
    } else {
      // 普通夹→速记夹：把首行作为标题、其余作为正文
      const lines = srcContent.split("\n");
      const title0 = (lines[0] || "").trim();
      const body0 = lines.slice(1).join("\n").replace(/^\s+/, "").trimEnd();
      destTitle = composeStickyContent(title0, body0);
    }
  } else {
    // 目标是普通夹
    if (srcIsSticky) {
      // 速记夹→普通夹：把 "### 标题\n\n正文" 压成单行
      const parsed = parseStickyContent(srcContent);
      destTitle = [parsed.title, parsed.body].filter(Boolean).join("\n");
    } else {
      // 普通夹→普通夹：原样搬入
      destTitle = srcContent;
    }
  }
  const srcFolderId = b.folderId;
  const moved = await api.moveTaskToFolder(b.id, targetFolderId);
  if (!moved) { flashSave(); toast("跨任务夹移动失败，请重试"); return; }
  // 形态变化时同步修正内容
  if (destTitle !== srcContent) {
    await api.updateContent(moved.id, destTitle);
  }
  // 目标夹是速记夹：便签夹没有「已完成」概念，任何进入速记夹的块重置为未完成
  // 否则源夹遗留的 is_completed 会让速记夹列表多出无意义状态
  // 目标夹是普通夹：保持源夹的完成状态（源夹已完成 → 目标夹也已完成）
  if (dstIsSticky) {
    if (moved.done) { await api.toggleTask(moved.id, false); }
  } else if (srcIsSticky) {
    // 速记夹 → 普通夹：速记夹内所有块都视为未完成，无需切换
  } else if (moved.done !== b.done) {
    // 普通夹 → 普通夹：moveTaskToFolder 创建的新任务默认 is_completed=false，
    // 若源块是已完成状态，需要同步切换回已完成
    if (b.done) { await api.toggleTask(moved.id, true); }
  }
  // 从当前 blocks 里移除（当前夹的 DOM 元素也移除）
  blocks = blocks.filter(x => x.id !== b.id);
  if (el.parentElement) el.remove();
  // 就地同步 folders[] 的 total/completed：否则 updateFolderCount / renderFolders
  // 读的还是 SQLite 里的旧值，用户必须再点一次夹子才看到新数字。
  const srcDecDone = srcIsSticky ? 0 : (b.done ? 1 : 0);
  const dstIncDone = dstIsSticky ? 0 : (b.done ? 1 : 0);
  const srcFolder = folders.find(f => Number(f.id) === Number(srcFolderId));
  if (srcFolder) {
    srcFolder.total = Math.max(0, (Number(srcFolder.total) || 0) - 1);
    srcFolder.completed = Math.max(0, (Number(srcFolder.completed) || 0) - srcDecDone);
  }
  if (target) {
    target.total = (Number(target.total) || 0) + 1;
    target.completed = (Number(target.completed) || 0) + dstIncDone;
  }
  // 刷新源夹与目标夹的待完成计数——跨夹移动会同时影响两边
  updateFolderCount(srcFolderId);
  updateFolderCount(targetFolderId);
  renderFolders();
  if (srcIsSticky) applyStickyLayout();
  toast(`已移动到「${target.name}」`);
}

/* 便利贴夹：把当前 DOM 顺序同步回内存 blocks 数组，并调用 API 持久化到
 * SQLite / localStorage。拖放结束后调用；失败静默降级（下一次拖放会重写）。 */
function persistStickyOrder() {
  const newOrder = [...board.querySelectorAll(".block.sticky")].map(el => Number(el.dataset.id));
  const map = new Map(blocks.map(b => [Number(b.id), b]));
  const ordered = newOrder.map(id => map.get(id)).filter(Boolean);
  blocks.forEach(b => { if (!newOrder.includes(Number(b.id))) ordered.push(b); });
  blocks = ordered;
  // fire-and-forget：拖放手感优先，持久化异步进行
  api.reorderSticky(newOrder).catch(err => {
    console.warn("[玻光画布] 便利贴顺序持久化失败:", err);
  });
}

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
    // 关键：清空 autoSize 写入的 min-width。便利贴夹由 CSS Grid
    // （grid-template-columns: repeat(auto-fill, minmax(220px, 1fr))）决定列宽，
    // 而 autoSize 会把 title.scrollWidth+46 写进 el.style.minWidth（内联样式
    // 优先级最高），一长串文本就会把整列撑到 510px，瀑布流退化成一列大卡。
    // 这里在应用布局时强制清零，让 Grid 重新按 minmax 计算列数。
    el.style.minWidth = "";
    el.style.width = "";
  });
  board.style.height = "auto";
}

/* 便利贴夹：把 id=dragId 的块移到 id=targetId 的块旁边。
 * 判断放在目标块之前还是之后：按 drop 时鼠标在目标块上半/下半决定。
 * DOM 顺序即显示顺序，同步 reorder 内存里的 blocks 数组，保证颜色/旋转由位置派生。 */
function reorderStickyBlocks(dragId, targetId, pos) {
  dragId = Number(dragId); targetId = Number(targetId);
  const dragEl = board.querySelector(`.block.sticky[data-id="${dragId}"]`);
  const targetEl = board.querySelector(`.block.sticky[data-id="${targetId}"]`);
  if (!dragEl || !targetEl || dragEl === targetEl) return;

  // 决定放在目标之前还是之后
  let place = "after";
  if (pos) place = pos;
  else if (lastDropPos) {
    const r = targetEl.getBoundingClientRect();
    place = (lastDropPos.clientY < r.top + r.height / 2) ? "before" : "after";
  }

  if (place === "before") targetEl.parentNode.insertBefore(dragEl, targetEl);
  else {
    if (targetEl.nextSibling) targetEl.parentNode.insertBefore(dragEl, targetEl.nextSibling);
    else targetEl.parentNode.appendChild(dragEl);
  }

  applyStickyLayout();
  persistStickyOrder();
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
  // 两步按钮点击防误触（无对话框版）：
  //   第一次点击 → 按钮变红 + 文案变「删除」→「确认」，视觉确认态，1.5s 无二次点击自动恢复。
  //   第二次点击 → 直接删除，不再弹 confirm()。
  // 目的：单次误触只让按钮变色，不弹任何对话框；用户看到按钮已经在「确认」态，
  // 再点一次才是明确的删除意图。移除 confirm() 是因为它反而让「第一次点击」像
  // 真的删除流程，用户不敢继续，取消时又被弹窗打断，比「一步」还糟。
  let delConfirmTimer = null;
  const resetDel = () => {
    del.classList.remove("pending");
    del.textContent = "×";
    del.title = "删除";
    if (delConfirmTimer) { clearTimeout(delConfirmTimer); delConfirmTimer = null; }
  };
  del.addEventListener("click", e => {
    e.stopPropagation();
    if (!del.classList.contains("pending")) {
      del.classList.add("pending");
      del.textContent = "确认";
      del.title = "再点一次确认删除";
      delConfirmTimer = setTimeout(resetDel, 1500);
      // 用户不知道下一步做什么时容易慌，用 toast 明说「你已经点了，再点一次」
      toast("再点一次「确认」完成删除");
      return;
    }
    resetDel();
    removeBlock(b.id);
  });
  // 编辑进入、点空白、离开窗口焦点时清除 pending，避免「1.5s 后没触发又忘了」的残留
  el.addEventListener("mousedown", e => {
    if (e.target !== del) resetDel();
  }, true);

  /* 放大编辑按钮：hover 显示在右下，点击后调用 enterZoomedEdit 把块
     「放大」到画布视口，编辑完毕后（title blur）自动恢复原始尺寸。
     便利贴夹由 CSS Grid 排布，不支持放大。 */
  const zoom = document.createElement("button");
  zoom.className = "block-zoom";
  zoom.textContent = "⤢";
  zoom.title = "放大编辑";
  zoom.addEventListener("click", e => {
    e.stopPropagation();
    enterZoomedEdit(el, b);
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
    el.append(title, meta, check, del, zoom);
  }

  /* ── 便利贴夹：原生 HTML5 拖放，允许在瀑布/列表里拖到其他块的位置互换 ── */
  if (inSticky) {
    el.setAttribute("draggable", "true");
    el.addEventListener("dragstart", e => {
      if (el.classList.contains("editing")) {
        e.preventDefault();
        return;
      }
      if (e.target === check || e.target === del) { e.preventDefault(); return; }
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", String(b.id)); } catch (_) {}
      _stickyDragEl = el;
      /* 稍等一帧再加类，避免浏览器把正在拖的截图带成半透明态 */
      requestAnimationFrame(() => el.classList.add("block-dragging"));
    });
    el.addEventListener("dragover", e => {
      if (!_stickyDragEl) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (_stickyDragEl === el) { el.classList.remove("block-drop-target"); return; }
      board.querySelectorAll(".block.sticky.block-drop-target").forEach(n => {
        if (n !== el) n.classList.remove("block-drop-target");
      });
      el.classList.add("block-drop-target");
    });
    el.addEventListener("dragleave", () => {
      el.classList.remove("block-drop-target");
    });
    el.addEventListener("drop", e => {
      e.preventDefault();
      el.classList.remove("block-drop-target");
      board.querySelectorAll(".block.sticky.block-drop-target").forEach(n => n.classList.remove("block-drop-target"));
      if (!_stickyDragEl) return;
      const dragId = Number(_stickyDragEl.dataset.id);
      const targetId = b.id;
      if (String(dragId) === String(targetId)) return;
      const r = el.getBoundingClientRect();
      const pos = (e.clientY < r.top + r.height / 2) ? "before" : "after";
      reorderStickyBlocks(dragId, targetId, pos);
    });
    el.addEventListener("dragend", () => {
      el.classList.remove("block-dragging");
      board.querySelectorAll(".block.sticky.block-drop-target").forEach(n => n.classList.remove("block-drop-target"));
      _stickyDragEl = null;
    });
  }

  el.addEventListener("dblclick", e => {
    if (e.target === check || e.target === del || e.target.classList.contains("block-zoom")) return;
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
    // 编辑结束前先把放大态恢复，避免下面的 return 早退漏了还原尺寸。
    // 幂等：非放大态调用会立即返回。
    exitZoomed(el);
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
    // 放大态下按 Esc：先只退出放大态，不做任何内容改动。
    // 直接 title.blur() 触发 blur handler，走正常保存路径——不丢编辑内容。
    if (el.__zoomed && e.key === "Escape") {
      e.preventDefault();
      exitZoomed(el);
      title.blur();
      return;
    }
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
  // 放大编辑态下不需要按内容缩放宽度，尺寸由 CSS 强制为 90% 视口
  if (el.classList.contains("zoomed")) return;
  // 便利贴夹的宽度由 CSS Grid（.board.sticky-wall 的
  // grid-template-columns: repeat(auto-fill, minmax(220px, 1fr))）统一分配，
  // 不能再写 el.style.minWidth——否则内联样式会盖过 Grid 的 1fr，
  // 把整列撑到 min-width（最高 510px），瀑布流就退化成「一列大卡」。
  // 用户编辑便签时也不需要动态宽度，让内容自适应换行即可。
  if (el.classList.contains("sticky")) return;
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

/* ---------- 放大编辑态 ----------
   enterZoomedEdit：把当前块切换到「放大」尺寸（fixed 覆盖视口），
   再走 startEdit 进入编辑态；title blur 时由 exitZoomed 恢复原尺寸。
   backdrop 遮罩用 body::after 伪元素实现（CSS 的 body.zoom-active::after），
   这里只切 body class 就能显示/隐藏，不用创建 DOM 节点。
   便利贴夹不支持放大。

   关键：必须把 el 从 .board 里移出到 document.body。
   原因——.canvas-wrap 上有 backdrop-filter: blur(30px)，按 CSS 规范，
   backdrop-filter（除 none 外）会让元素成为 fixed 定位子孙的「包含块」。
   也就是说，如果 .block.zoomed 还留在 .board 里，它的 position:fixed
   就不是相对视口，而是相对 .canvas-wrap 定位，导致尺寸和位置全都偏掉。
   实测：view 1042×609 时，zoomed 块实测 rect = {325, 43, 652×522}
   而不是理论值 {52, 30, 938×548}——偏移和尺寸都等于 canvas-wrap 的框。
   移出到 body 后 fixed 才参照视口。exitZoomed 时按 __origParent
   + __origNextSibling 精确放回原位置，视觉无缝。 */
function enterZoomedEdit(el, b) {
  if (el.classList.contains("sticky")) return;
  if (el.classList.contains("editing")) return;
  if (!el.classList.contains("block")) return;
  // 记录原始位置，退出时精确还原（用 nextSibling 保留在兄弟中的顺序）
  el.__origParent = el.parentElement;
  el.__origNextSibling = el.nextSibling;
  // 逃出 .canvas-wrap 的 backdrop-filter 包含块
  document.body.appendChild(el);
  document.body.classList.add("zoom-active");
  el.classList.add("zoomed");
  el.__zoomed = true;
  startEdit(el, b);
}

function exitZoomed(el) {
  if (!el || !el.__zoomed) return;
  el.__zoomed = false;
  el.classList.remove("zoomed");
  document.body.classList.remove("zoom-active");
  // 还原回原父节点的原位置
  const parent = el.__origParent;
  const next = el.__origNextSibling;
  if (parent && el.parentElement === document.body) {
    if (next && next.parentNode === parent) parent.insertBefore(el, next);
    else parent.appendChild(el);
  }
  el.__origParent = null;
  el.__origNextSibling = null;
}

/* 点击放大块以外区域退出放大：CSS 里 body::after 遮罩设了
   pointer-events: none，所以画布外区域的 click 会落到 body 上。
   这里补回"点遮罩退出"的手势。事件在文档级冒泡阶段捕获，
   放大块内部的点击（编辑标题、点按钮）因为 e.target.closest 会命中
   .block.zoomed 而直接放行。 */
document.addEventListener("click", e => {
  if (!document.body.classList.contains("zoom-active")) return;
  const zoomedEl = document.querySelector(".block.zoomed");
  if (!zoomedEl) { document.body.classList.remove("zoom-active"); return; }
  if (e.target.closest(".block.zoomed")) return;
  // 触发 blur 走正常保存路径，不直接 exitZoomed，避免丢失编辑内容
  const t = zoomedEl.querySelector(".block-title");
  if (t && document.activeElement === t) t.blur();
  else exitZoomed(zoomedEl);
});

/* ---------- 双击空白新建 ---------- */
canvas.addEventListener("dblclick", e => {
  if (e.target.closest(".block")) return;
  /* 便利贴夹：双击空白不新建便签，避免误触；用户按 Ctrl+Q 或工具栏「+」添加 */
  if (isStickyFolderActive()) return;
  const rect = board.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const clickY = e.clientY - rect.top;
  const dy = dividerY();
  // 靠左对齐模式下，双击位置不再决定落点（新块统一追加到栈底）；
  // 但 API 需要一个合法 y，随便给一个远高 dy 的值，随后 alignPendingBlocks
  // 会把它排到最下边行——不影响最终视觉位置。
  const x = Math.max(16, Math.round(clickX));
  const y = clickY > dy + 24 ? Math.round(clickY) : Math.round(dy + 34);
  api.createTask(activeFolderId, "", x, y).then(nb => {
    nb.title = ""; // 新建时先显示空内容，直接编辑
    blocks.push(nb);
    renderAll();
    // 对齐模式下立即把新块塞到栈底，视觉与「输入内容后追加到最下边行」一致
    if (alignMode && !isStickyFolderActive()) alignPendingBlocks([nb.id]);
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
  // 对齐模式下：把这一批新块全部追加到栈底（旧块保持视觉顺序不动）
  if (alignMode && !isStickyFolderActive()) {
    alignPendingBlocks(created.map(x => x.id));
  }
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
  /* 跨任务夹移动：记录本轮拖动中最后一次悬停在侧栏任务夹上的 li。
   * 用 elementFromPoint 探测，非 DnD；释放时若不为 null 就迁过去。 */
  let _sidebarDropTarget = null;

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
    // 探测当前光标下是否落在侧栏某个任务夹上（用于跨夹移动的视觉反馈）
    const hit = document.elementFromPoint(ev.clientX, ev.clientY);
    const li = hit && hit.closest ? hit.closest(".folder-item") : null;
    if (li !== _sidebarDropTarget) {
      if (_sidebarDropTarget) _sidebarDropTarget.classList.remove("block-move-target");
      if (li) li.classList.add("block-move-target");
      _sidebarDropTarget = li;
    }
    // 跨夹移动时不再更新块的 transform，视觉上让块跟随光标由 cursor:grabbing 暗示
    if (li) return;
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

  const onUp = upEv => {
    if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    if (!started) return;
    try { el.releasePointerCapture(upEv.pointerId); } catch (_) {}
    el.classList.remove("dragging");
    canvasWrap.classList.remove("is-dragging");
    document.body.classList.remove("is-dragging");
    el.style.transform = "";
    document.body.style.cursor = "";
    guideV.hidden = true; guideH.hidden = true;
    /* 跨任务夹迁移：松手时若悬停在另一个任务夹上，直接迁过去。
     * 不做二次确认——用户可以再拖回来；速度优先。
     * 注意：先保存 targetId 再清理类，最后置空引用——顺序写反会永远走不进 if 分支。 */
    if (_sidebarDropTarget) {
      const targetId = Number(_sidebarDropTarget.dataset.id);
      const targetLi = _sidebarDropTarget;
      _sidebarDropTarget = null;
      targetLi.classList.remove("block-move-target");
      // 用 elementFromPoint 再确认一次（避免最后一次 move 与 up 之间用户又移开）
      const finalHit = document.elementFromPoint(upEv.clientX, upEv.clientY);
      const finalLi = finalHit && finalHit.closest ? finalHit.closest(".folder-item") : null;
      if (finalLi && Number(finalLi.dataset.id) === targetId) {
        handleCrossFolderDrop(targetId, el, b);
      }
      return;
    }

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
      // 同步刷新侧栏当前夹的「待完成数量」badge
      updateFolderCount(activeFolderId);
      // 处于「靠左对齐」模式下，任何跨区拖动后都强制重排：
      //   · 从 done 拖回 pending（!shouldDone）：本块是新加入的，追加到最下边行
      //   · 从 pending 拖到 done：本块离开，其他块保持原顺序重排
      if (alignMode && !isStickyFolderActive()) {
        alignPendingBlocks(!shouldDone ? [b.id] : []);
      }
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
        // 对齐模式下：pending 块被拖动会打乱堆栈，立即按 y 升序重排回堆栈
        if (alignMode && !isStickyFolderActive()) alignPendingBlocks([]);
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
  // 对齐模式下：一个 pending 块被移除，剩余 pending 块按当前 y 升序重新堆栈；
  // 目标块内容变了但 id 不变，走「纯重排」路径（[]），不追加到底部。
  if (alignMode && !isStickyFolderActive()) alignPendingBlocks([]);
  mirrorNow();
  // 同步刷新侧栏当前夹的「待完成数量」badge（被合并的块从 pending 里消失）
  updateFolderCount(activeFolderId);
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
  // 勾选后如果处于「靠左对齐」模式，把待完成区重新堆栈：
  //   · 从已完成勾回待完成（!b.done）——本块重新加入 pending，追加到最下边行
  //   · 从待完成勾到已完成（b.done）——本块离开，其他 pending 块保持原顺序重排
  if (alignMode && !isStickyFolderActive()) {
    alignPendingBlocks(!b.done ? [b.id] : []);
  }
  // 同步刷新侧栏当前夹的「待完成数量」badge
  updateFolderCount(activeFolderId);
}
function removeBlock(id) {
  blocks = blocks.filter(b => b.id !== id);
  api.deleteTask(id);
  const el = board.querySelector(`.block[data-id="${id}"]`);
  if (el) el.remove();
  if (id === selectedBlockId) clearSelection();
  relayout(false);
  // 对齐模式下：删除一个 pending 块后，剩余 pending 块按当前 y 升序重新堆栈
  if (alignMode && !isStickyFolderActive()) alignPendingBlocks([]);
  mirrorNow();
  // 同步刷新侧栏当前夹的「待完成数量」badge
  updateFolderCount(activeFolderId);
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
  // 未购买代码签名证书，Windows 首次打开 exe 时会弹 SmartScreen 「打开前请确保信任此应用」。
  // 这里在弹窗内前置说明，避免用户以为是病毒而中止安装；macOS/Linux 没有该警告，隐藏。
  const ss = $("update-smartscreen");
  if (ss) ss.hidden = !/Windows/.test(navigator.userAgent);
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
  // 每个文件夹独立记忆「靠左对齐」开关，切夹时按新夹的偏好恢复；
  // 不再强制关掉——否则勾选对齐后随便切一下文件夹，对齐就失效了。
  alignMode = getAlignMode(id);
  savedPositions = {};
  alignToggle.checked = alignMode;
  await reloadTasks();
  renderAll();
  if (alignMode && !isStickyFolderActive()) alignPendingBlocks([]);
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
  // 应用「靠左对齐」的持久化偏好（按文件夹）；
  // 放在 renderAll 之前，renderAll 内部走的是 relayout，
  // 而 renderAll 后我们再用 alignPendingBlocks([]) 强制对齐一次，
  // 保证从磁盘加载回来的旧块也重新堆栈。
  alignMode = activeFolderId ? getAlignMode(activeFolderId) : false;
  alignToggle.checked = alignMode;
  renderAll();
  // 首次进入时如开启了对齐，立即对齐已有块。走「纯重排」路径（[]），
  // 保留用户上次手动对齐时的视觉顺序，不做「追加到栈底」的重排。
  if (alignMode && !isStickyFolderActive()) alignPendingBlocks([]);
  // 绑定速记夹按钮
  bindStickyEvents();
  alignToggle.addEventListener("change", () => {
    alignMode = alignToggle.checked;
    if (activeFolderId) saveAlignMode(activeFolderId, alignMode);
    if (alignMode) alignPendingBlocks([]);
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
