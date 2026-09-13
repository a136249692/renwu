import { invoke as invokeImpl } from "@tauri-apps/api/core";

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
const STICKY_FOLDER = "便利贴";

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

/* ---------- 默认任务夹 ---------- */
function getDefaultFolderId() {
  try { return localStorage.getItem(DEFAULT_FOLDER_KEY); } catch { return null; }
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
const DIVIDER_RATIO = 0.4;

let folders = [];
let blocks = [];
let activeFolderId = null;
let saveTimer = null;

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
const boardEmpty = $("board-empty");
const stickyPopup = $("sticky-popup");
const stickyInput = $("sticky-input");

/* ---------- 便利贴状态 ---------- */
let stickyFolderId = null;

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
  return f.name === STICKY_FOLDER;
}

/* ---------- 分界线 ---------- */
function defaultDividerY() {
  const h = canvas.clientHeight || window.innerHeight;
  return Math.max(160, Math.round(h * DIVIDER_RATIO));
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

/* ---------- 渲染侧栏 ---------- */
function renderFolders() {
  folderListEl.innerHTML = "";
  const sorted = [...folders].sort((a, b) => {
    const aSticky = isStickyFolder(a) ? 0 : 1;
    const bSticky = isStickyFolder(b) ? 0 : 1;
    return aSticky - bSticky;
  });
  const defId = getDefaultFolderId();
  sorted.forEach(f => {
    const locked = isStickyFolder(f);
    const isDefault = f.id === defId;
    const li = document.createElement("li");
    li.className = "folder-item" + (f.id === activeFolderId ? " active" : "") + (locked ? " locked" : "");
    const starHtml = isDefault
      ? '<span class="default-star" title="默认任务夹">★</span>'
      : '<button class="star-btn" title="设为默认任务夹">☆</button>';
    li.innerHTML = `<span class="ico">📁</span><span class="name"></span>${starHtml}${locked ? '<span class="lock-icon">🔒</span>' : ''}<button class="rm" title="删除任务夹">×</button>`;
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
    folderListEl.appendChild(li);
  });
}

/* ---------- 渲染画布（协调式：新增才建，多余才删） ---------- */
function renderAll() {
  renderFolders();
  const f = folders.find(x => x.id === activeFolderId);
  if (!f) { folderTitle.textContent = "请选择任务夹"; return; }
  folderTitle.textContent = f.name;

  const existing = new Map();
  [...board.querySelectorAll(".block")].forEach(el => existing.set(Number(el.dataset.id), el));
  blocks.forEach(b => {
    let el = existing.get(b.id);
    if (el) { existing.delete(b.id); el.__b = b; }
    else { board.appendChild(makeBlock(b)); }
  });
  existing.forEach(el => el.remove()); // 清掉多余节点

  relayout(false);
  restoreScroll();
}

/* 定位一个已存在的块元素 */
function encodePos(el, b) {
  el.style.top = b.y + "px";
  if (b.row) { el.style.left = ""; el.style.right = "20px"; }
  else el.style.left = b.x + "px";
}

/* 已完成块按顺序堆叠：默认按创建时间从远到近排序（旧→新），
   手动拖动后切到自由排序（按 y 位置），杜绝重叠 */
function layoutDoneRows() {
  const mode = getDoneSortMode();
  const doneList = blocks.filter(b => b.done).sort(
    mode === "manual" ? (a, b) => a.y - b.y : (a, b) => a.createdAt - b.createdAt
  );
  let cursor = 14;
  for (const b of doneList) {
    b.x = 20; b.row = true;
    const el = board.querySelector(`.block[data-id="${b.id}"]`);
    const h = el ? el.offsetHeight : 44;
    b.y = cursor;
    cursor += h + 10;
  }
  return { doneList, total: cursor - 10 };
}

/* 就地重排：只改位置/类名，不重建 DOM（无闪烁、无 blockIn 重播） */
function relayout(initial) {
  // 先设置类，确保按最终形态（.done/.row）算出真实高度
  for (const b of blocks) {
    const el = board.querySelector(`.block[data-id="${b.id}"]`);
    if (!el) continue;
    el.classList.toggle("done", b.done);
    el.classList.toggle("row", b.row);
  }
  const { doneList, total } = layoutDoneRows();
  const need = doneList.length ? 14 + total + 46 : 0;
  const defY = defaultDividerY();
  const f = folders.find(x => x.id === activeFolderId);
  // 待完成区高度固定的核心：floor = max(已存 dividerY, 新默认)
  //   · 已存值 > defY（旧数据已撑大）→ 保留原值，不收缩
  //   · 已存值 < defY（旧 30% 默认或新文件夹初始 0）→ 抬升到新默认 40%
  // 这样：待完成区始终 ≥ 60%，已完成内容变少不会把它挤压回去
  const floor = Math.max(f && f.dividerY || 0, defY);
  const dy = Math.max(floor, need);
  if (f) { f.dividerY = dy; setDividerY(activeFolderId, dy); }
  paintDivider();

  const todo = blocks.filter(b => !b.done).length;
  const done = blocks.length - todo;
  boardEmpty.hidden = blocks.length > 0;
  const doneHint = $("done-hint");
  if (doneHint) doneHint.hidden = !(blocks.length > 0 && done === 0);
  const pLabel = $("pending-label");
  if (pLabel) pLabel.innerHTML = `待完成 <b>${todo}</b>`;
  const topLabel = divider.querySelector(".label.top");
  if (topLabel) topLabel.textContent = done ? `已完成 ${done}` : "已完成";

  let maxY = dy + 200;
  for (const b of blocks) {
    if (b.done) maxY = Math.max(maxY, b.y + (board.querySelector(`.block[data-id="${b.id}"]`)?.offsetHeight || 44) + 40);
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

/* 待完成区摆放：从分界线下方开始搜索空位，按每个块的真实尺寸判定重叠，
   保证「拖回待完成区」时一定落在分界线下方且不与已有块重叠 */
function findFreeSpot(b, dy) {
  // 记录真实渲染尺寸（row 形态宽度与自由摆放不同，必须实时测量）
  for (const o of blocks) {
    const el = board.querySelector(`.block[data-id="${o.id}"]`);
    if (el) { o.w = el.offsetWidth; o.h = el.offsetHeight; }
  }
  // 被摆放的块自身尺寸也要实时测量；待完成区形态下它不是 .row，
  // 先把类清掉测一次，避免用「完成区整行宽度」去判重叠。
  const selfEl = board.querySelector(`.block[data-id="${b.id}"]`);
  if (selfEl) {
    const cls = selfEl.classList;
    cls.remove("done", "row");
    b.w = selfEl.offsetWidth; b.h = selfEl.offsetHeight;
  }
  const dx = 120, dyStep = 78;
  const boardW = board.clientWidth || 900;
  // 起点必须是「分界线下方」，不能用旧坐标：已完成的块原位置在分界线上方，
  // 直接沿用会把块放回完成区，看起来就像「标记未完成没反应」。
  let x = Math.max(16, b.x || 16), y = dy + 28;
  const w = Math.max(180, b.w || 200), h = Math.max(40, b.h || 48);
  const maxX = Math.max(16, boardW - w - 16);
  for (let tries = 0; tries < 48; tries++) {
    const clash = blocks.some(o => {
      if (o.id === b.id) return false;
      const ow = Math.max(180, o.w || 200), oh = Math.max(40, o.h || 48);
      return x < o.x + ow && x + w > o.x && y < o.y + oh && y + h > o.y;
    });
    if (!clash) break;
    x += dx;
    if (x > maxX) { x = 16; y += dyStep; }
  }
  b.x = Math.max(16, Math.min(x, maxX));
  b.y = Math.max(dy + 28, y);
}

/* ---------- 生成任务块 ---------- */
function makeBlock(b) {
  const el = document.createElement("div");
  el.className = "block" + (b.done ? " done" : "") + (b.row ? " row" : "");
  el.style.top = b.y + "px";
  if (!b.row) el.style.left = b.x + "px";
  el.dataset.id = b.id;
  el.__b = b;

  const title = document.createElement("div");
  title.className = "block-title";
  title.textContent = b.title;
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
  del.addEventListener("click", e => { e.stopPropagation(); removeBlock(b.id); });

  el.append(title, meta, check, del);

  el.addEventListener("dblclick", e => {
    if (e.target === check || e.target === del) return;
    startEdit(el, b);
  });
  title.addEventListener("input", () => {
    const txt = getTitleText(title);
    b.title = txt;
    flashSave();
    api.updateContent(b.id, txt);
    mirrorNow();
    autoSize(el, b, title);
  });
  title.addEventListener("blur", () => {
    const txt = getTitleText(title);
    const oldContent = title.dataset.oldContent || b.title;
    // 空白内容块不保存：直接删除该块（含后端记录）
    if (!txt.trim()) {
      el.classList.remove("editing");
      title.contentEditable = "false";
      removeBlock(b.id);
      return;
    }
    const final = txt;
    b.title = final;
    title.textContent = final;
    title.contentEditable = "false";
    el.classList.remove("editing");
    api.updateContent(b.id, final);
    // 记录变更历史
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

/* ---------- 拖动 + 磁吸对齐 ---------- */
function startDrag(e, el, b) {
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
    const elH2 = el.offsetHeight || elH;
    const centerY = b.y + elH2 / 2;
    const shouldDone = centerY < dividerY();
    if (shouldDone !== b.done) {
      b.done = shouldDone; b.row = shouldDone;
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
  // 显示合并提示
  showMergeHint(el);
  // 合并内容
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
    findFreeSpot(b, dy);
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
  if (isStickyFolder(f)) { alert("便利贴任务夹不可删除"); return; }
  if (!confirm(`确定删除任务夹「${f.name}」及其全部任务？`)) return;
  await api.deleteFolder(id);
  folders = folders.filter(x => x.id !== id);
  blocks = blocks.filter(b => b.folderId !== id);
  if (activeFolderId === id) activeFolderId = folders.length ? folders[0].id : null;
  if (!folders.length) {
    const nf = await api.createFolder("我的任务");
    folders.push(nf); activeFolderId = nf.id;
  }
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

/* ---------- 滚动位置记忆 ---------- */
function saveScroll() {
  try {
    const map = JSON.parse(localStorage.getItem(SCROLL_KEY) || "{}");
    map[activeFolderId] = { x: canvas.scrollLeft, y: canvas.scrollTop };
    localStorage.setItem(SCROLL_KEY, JSON.stringify(map));
  } catch {}
}
function restoreScroll() {
  try {
    const map = JSON.parse(localStorage.getItem(SCROLL_KEY) || "{}");
    const s = map[activeFolderId];
    if (s) { canvas.scrollLeft = s.x || 0; canvas.scrollTop = s.y || 0; }
  } catch {}
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
    activeFolderId = (defId && folders.find(x => x.id === Number(defId)))
      ? Number(defId) : folders[0].id;
  }
}
/* 切换到指定任务夹并重新加载其任务（避免串夹显示错误数据） */
async function selectFolder(id) {
  if (activeFolderId === id && blocks.some(b => b.folderId === id)) return;
  clearSelection();
  activeFolderId = id;
  saveScroll();
  await reloadTasks();
  renderAll();
}
async function reloadTasks() {
  if (!activeFolderId) { blocks = []; return; }
  blocks = await api.getTasks(activeFolderId);
  // 迁移旧数据
  const allZero = blocks.length > 0 && blocks.every(b => b.x === 0 && b.y === 0);
  if (allZero) {
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

/* ---------- 便利贴弹窗 ---------- */
function toggleStickyPopup() {
  if (stickyPopup.hidden) showStickyPopup();
  else closeStickyPopup();
}
function showStickyPopup() {
  const rect = canvas.getBoundingClientRect();
  stickyPopup.style.left = (window.innerWidth / 2 - 150) + "px";
  stickyPopup.style.top = (window.innerHeight / 2 - 100) + "px";
  stickyPopup.hidden = false;
  stickyInput.value = "";
  stickyInput.focus();
}
function closeStickyPopup() {
  stickyPopup.hidden = true;
  stickyInput.value = "";
}
async function saveStickyNote() {
  const text = stickyInput.value.trim();
  if (!text) { closeStickyPopup(); return; }
  let fid = stickyFolderId;
  if (!fid || !folders.find(f => f.id === fid)) {
    fid = await ensureStickyFolder();
  }
  const dy = dividerY();
  const nb = await api.createTask(fid, text, 16, dy + 34);
  if (activeFolderId === fid) {
    blocks.push(nb);
    renderAll();
    findFreeSpot(nb, dy);
    await api.moveTask(nb.id, nb.x, nb.y);
    renderAll();
  }
  closeStickyPopup();
  flashSave();
  mirrorNow();
}

/* ---------- 确保便利贴任务夹存在 ---------- */
async function ensureStickyFolder() {
  const existing = folders.find(f => isStickyFolder(f));
  if (existing) { stickyFolderId = existing.id; return existing.id; }
  const nf = await api.createFolder(STICKY_FOLDER);
  folders.push(nf);
  stickyFolderId = nf.id;
  return nf.id;
}

/* ---------- 事件绑定 ---------- */
function bindStickyEvents() {
  $("sticky-save").addEventListener("click", saveStickyNote);
  $("sticky-cancel").addEventListener("click", closeStickyPopup);
  stickyInput.addEventListener("keydown", e => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveStickyNote(); }
    if (e.key === "Escape") { e.stopPropagation(); closeStickyPopup(); }
  });
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
  // 绑定便利贴按钮
  bindStickyEvents();
  // 窗口关闭前保存滚动位置
  window.addEventListener("beforeunload", saveScroll);
}
boot();
