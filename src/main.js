import { invoke } from "@tauri-apps/api/core";

/* ═══════════════════════════════════════════════════ *
 *  Tauri / localStorage 双模式适配层
 *  桌面端走 invoke → Rust/SQLite；浏览器预览走 localStorage
 * ═══════════════════════════════════════════════════ */
const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

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
      return list.map(f => ({ ...f, dividerY: getDividerY(f.id) }));
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
      return { ...f, dividerY: getDividerY(f.id) };
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
      return list.map(mapTask);
    }
    const d = lsLoadAll();
    return (d.tasks || []).filter(t => t.folder_id === folderId).map(mapTask);
  },
  async createTask(folderId, title, x, y) {
    if (isTauri()) {
      const t = await invoke("create_task", { folderId, content: title, positionX: x, positionY: y });
      return mapTask(t);
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
      return mapTask(t);
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

/* ---------- 工具 ---------- */
function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts), p = n => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function escapeHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
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

/* ---------- 渲染侧栏 ---------- */
function renderFolders() {
  folderListEl.innerHTML = "";
  folders.forEach(f => {
    const li = document.createElement("li");
    li.className = "folder-item" + (f.id === activeFolderId ? " active" : "");
    li.innerHTML = `<span class="ico">📁</span><span class="name"></span><button class="rm" title="删除任务夹">×</button>`;
    li.querySelector(".name").textContent = f.name;
    li.addEventListener("click", e => {
      if (e.target.classList.contains("rm")) return;
      selectFolder(f.id);
    });
    li.querySelector(".rm").addEventListener("click", e => {
      e.stopPropagation(); removeFolder(f.id);
    });
    li.addEventListener("dblclick", e => {
      if (!e.target.classList.contains("rm")) openModal("rename", f);
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

/* 就地重排：只改位置/类名，不重建 DOM（无闪烁、无 blockIn 重播） */
function relayout(initial) {
  const doneList = blocks.filter(b => b.done).sort((a, b) => a.createdAt - b.createdAt);
  doneList.forEach((b, i) => { b.x = 16; b.row = true; b.y = 16 + i * 56; });
  const need = doneList.length ? 16 + doneList.length * 56 + 40 : 0;
  const dy = Math.max(defaultDividerY(), need);
  const f = folders.find(x => x.id === activeFolderId);
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

  const maxY = blocks.reduce((m, b) => Math.max(m, b.y + 90), 500);
  board.style.height = Math.max(maxY + 120, canvas.clientHeight - 2) + "px";

  const doneUl = new Set(doneList.map(b => b.id));
  for (const b of blocks) {
    const el = board.querySelector(`.block[data-id="${b.id}"]`);
    if (!el) continue;
    el.classList.toggle("done", b.done);
    el.classList.toggle("row", b.row);
    const check = el.querySelector(".block-check");
    if (check) check.textContent = b.done ? "✓" : "";
    encodePos(el, b);
    if (doneUl.has(b.id)) {
      // 已完成块保证排在最前（DOM 顺序），使整行在上层
      board.appendChild(el);
    }
  }
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

  const title = el.querySelector(".block-title");
  const wasEditing = title.contentEditable === "true";
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
    if (wasEditing) { try { title.blur(); } catch (_) {} }
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
    document.body.style.cursor = "grabbing";
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
      relayout(false);
      mirrorNow();
    } else {
      api.moveTask(b.id, b.x, b.y);
      el.classList.remove("done", "row");
      encodePos(el, b);
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
    b.done = true; b.row = true; b.x = 16; b.y = 16;
    api.toggleTask(id, true);
  } else {
    b.done = false; b.row = false;
    b.x = Math.max(16, b.x); b.y = dy + 30;
    api.toggleTask(id, false);
    api.moveTask(id, b.x, b.y);
  }
  relayout(false);
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
  if (!activeFolderId || !folders.find(x => x.id === activeFolderId))
    activeFolderId = folders[0].id;
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
  if (e.key === "Escape") { clearSelection(); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) {
    const ae = document.activeElement;
    if (ae && (ae.isContentEditable || ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) return;
    if (selectedBlockId == null) return;
    e.preventDefault();
    copySelectedBlock();
  }
});

/* ---------- 启动 ---------- */
async function boot() {
  renderFolders();
  if (isTauri()) {
    // 记录存储位置，便于排查保存问题
    try { console.info("[玻光画布] 存储信息:", await invoke("storage_info")); } catch (e) { console.error("[玻光画布] 获取存储信息失败", e); }
  } else {
    console.info("[玻光画布] 浏览器预览模式，数据存于 localStorage");
  }
  await reloadFolders();
  await reloadTasks();
  await restoreFromMirror();
  renderAll();
}
boot();
