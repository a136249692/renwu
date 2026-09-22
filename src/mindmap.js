/* ═══════════════════════════════════════════════════ *
 *  思维导图模块（任务/思维 双模式）
 *  桌面端走 invoke → Rust/SQLite；浏览器预览走 localStorage 兜底。
 *  左侧：思维导图名称列表（新建/重命名/删除）
 *  右侧：思维导图画布（节点拖拽 / 连线 / 缩放 / 平移 / 编辑）
 * ═══════════════════════════════════════════════════ */
import { invoke as invokeImpl } from "@tauri-apps/api/core";

const $ = id => document.getElementById(id);

function detectTauri() {
  if (typeof window === "undefined") return false;
  if ("__TAURI_INTERNALS__" in window) return true;
  const t = window.__TAURI__;
  return !!(t && (t.core || t.invoke));
}
const isTauri = detectTauri;

/* 远端优先，失败回退 localStorage 的轻量封装 */
async function mi(cmd, args) {
  if (isTauri()) {
    try { return await invokeImpl(cmd, args); }
    catch (e) { console.warn(`[思维导图] invoke("${cmd}") 失败:`, e); }
  }
  return null;
}

/* ---------- localStorage 兜底 ---------- */
const LS_MAPS = "glassCanvas.mindmaps";
const LS_NODES = "glassCanvas.mindNodes";
const LS_EDGES = "glassCanvas.mindEdges";
const LS_MAP_ORDER = "glassCanvas.mindOrder";   // { mapId: 0..n-1 } 手动排序
function lsLoadOrder() {
  try { return JSON.parse(localStorage.getItem(LS_MAP_ORDER) || "{}"); } catch { return {}; }
}
function lsSaveOrder(m) { try { localStorage.setItem(LS_MAP_ORDER, JSON.stringify(m)); } catch {} }
function lsLoadOf(key) {
  try { return JSON.parse(localStorage.getItem(key) || "[]"); } catch { return []; }
}
function lsSaveOf(key, arr) { try { localStorage.setItem(key, JSON.stringify(arr)); } catch {} }
let lsMaps = lsLoadOf(LS_MAPS);
let lsNodesArr = lsLoadOf(LS_NODES);
let lsEdgesArr = lsLoadOf(LS_EDGES);
let _lsIdSeq = 0;

/* ---------- 工具 ---------- */
function esc(s) {
  return String(s ? s : "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function nowTs() { return Date.now(); }

/* ---------- DOM 引用 ---------- */
const confirmModal = $("confirm-modal");
const confirmTitle = $("confirm-title");
const confirmMsgEl = $("confirm-msg");
const confirmOkBtn = $("confirm-ok");
const confirmCancelBtn = $("confirm-cancel");
const tabTasks = $("tab-tasks");
const tabMind = $("tab-mind");
const tabImages = $("tab-images");
const newFolderBtn = $("new-folder-btn");
const folderListEl = $("folder-list");
const modeBodyMind = $("mode-body-mind");
const modeBodyImages = $("mode-body-images");
const folderPane = $("mode-pane-tasks");
const mindPane = $("mode-pane-mind");
const imagePane = $("mode-pane-images");
const mapListEl = $("map-list");
const newMapBtn = $("new-map-btn");
const mindTitle = $("mind-title");
const mindMeta = $("mind-meta");
const mindToolbar = $("mind-toolbar");
const zoomOutBtn = $("mind-zoom-out");
const zoomInBtn = $("mind-zoom-in");
const zoomLabel = $("mind-zoom-label");
const fitBtn = $("mind-fit");
const mindCanvas = $("mind-canvas");
const mindWorld = $("mind-world");
const mindEdgesSvg = $("mind-edges");
const mindNodesWrap = $("mind-nodes");
const mindEmpty = $("mind-empty");

/* ---------- 状态 ---------- */
let mode = "tasks";          // tasks | mind
let maps = [];               // Mindmap[]
let activeMapId = null;      // 当前打开的思维导图 id
let activeMap = null;        // { id,name,pan_x,pan_y,zoom }
let view = { x: 40, y: 40, zoom: 1 };   // 平移 + 缩放
let nodes = [];              // MindmapNode[] (当前导图)
let edges = [];              // MindmapEdge[] (当前导图)
let pendingEdges = [];       // 编辑中新增的边（连线是否会合并）
const nodeEls = new Map();   // nodeId -> DOM el

let selectedNodeId = null;
let selectedEdgeId = null;
let editingNode = null;      // 正在编辑内容的节点对象
let connectingPort = null;   // { node, x, y } 连线起点
let tempEdgeEl = null;       // 临时连线 <path>
let drag = null;               // 当前拖拽/平移会话
let _viewTimer = null;         // 视野防抖保存定时器

const NODE_W = 210;
const MIN_ZOOM = 0.25, MAX_ZOOM = 2.5;

/* ---------- 应用内确认弹窗 ----------
   返回 Promise<boolean>。不用 window.confirm()：原生 confirm 依赖宿主 WebView
   的原生对话框能力，在部分宿主环境里支持不完整（可能弹不出来甚至触发宿主
   自身的 UI 异常）。应用内弹窗由我们自己的 DOM 控制，行为完全可预期。 */
let _confirmResolve = null;
let _renaming = false;        // 是否有导图名称输入框处于编辑中（用于 renderMapList 跳过重建）
let _mapDragSuppressed = false;   // 拖动结束后吞掉一次随后的 click（避免拖拽变成选图）
let _mapDragSrc = null;         // 当前拖动源导图 id
let _mapDragSrcEl = null;
let _mapDragX = null, _mapDragY = null;
function askConfirm(message, opts) {
  const o = opts || {};
  return new Promise(resolve => {
    confirmTitle.textContent = o.title || "确认操作";
    confirmMsgEl.innerHTML = message;
    confirmOkBtn.textContent = o.okText || "确认";
    _confirmResolve = resolve;
    confirmModal.hidden = false;
    // 把 resolve 挂到全局，让 image-wall.js 等其他模块也能触发同一弹窗。
    window.__confirmResolve = resolve;
  });
}
function closeConfirm(ok) {
  if (confirmModal.hidden) return;
  confirmModal.hidden = true;
  const r = _confirmResolve || window.__confirmResolve;
  _confirmResolve = null;
  window.__confirmResolve = null;
  if (r) r(ok);
}

/* ---------- API（SQLite 优先，localStorage 兜底） ---------- */
async function apiListMaps() {
  const r = await mi("list_mindmaps");
  if (r) return r;
  return lsMaps.slice();
}
async function apiCreateMap(name) {
  const r = await mi("create_mindmap", { name });
  if (r) return r;
  const id = (_lsIdSeq--); // 负数 id，不与 SQLite 自增冲突
  const m = { id, name: (name && name.trim()) || "未命名思维导图", created_at: nowTs(), pan_x: 40, pan_y: 40, zoom: 1 };
  lsMaps.push(m); lsSaveOf(LS_MAPS, lsMaps);
  return m;
}
async function apiRenameMap(id, name) {
  if (isTauri()) await mi("rename_mindmap", { id, name });
  const name_ = name || "未命名思维导图";
  const m = maps.find(x => x.id === id);
  if (m) m.name = name_;
  const lm = lsMaps.find(x => x.id === id);
  if (lm) { lm.name = name_; lsSaveOf(LS_MAPS, lsMaps); }
}
async function apiDeleteMap(id) {
  if (isTauri()) await mi("delete_mindmap", { id });
  maps = maps.filter(x => x.id !== id);
  lsMaps = lsMaps.filter(x => x.id !== id); lsSaveOf(LS_MAPS, lsMaps);
  lsNodesArr = lsNodesArr.filter(n => n.map_id !== id); lsSaveOf(LS_NODES, lsNodesArr);
  lsEdgesArr = lsEdgesArr.filter(e => e.map_id !== id); lsSaveOf(LS_EDGES, lsEdgesArr);
}
async function apiSaveView(id, x, y, zoom) {
  if (isTauri()) await mi("update_mindmap_view", { id, panX: x, panY: y, zoom });
  const m = maps.find(v => v.id === id);
  if (m) { m.pan_x = x; m.pan_y = y; m.zoom = zoom; }
  const lm = lsMaps.find(v => v.id === id);
  if (lm) { lm.pan_x = x; lm.pan_y = y; lm.zoom = zoom; lsSaveOf(LS_MAPS, lsMaps); }
}
async function apiListNodes(mapId) {
  const r = await mi("list_mindmap_nodes", { mapId });
  if (r) return r;
  return lsNodesArr.filter(n => n.map_id === mapId).slice();
}
async function apiCreateNode(mapId, content, x, y) {
  const r = await mi("create_mindmap_node", { mapId, content, x, y });
  if (r) {
    nodes.push(r);
    return r;
  }
  const id = (_lsIdSeq--);
  const n = { id, map_id: mapId, content, x, y, created_at: nowTs() };
  lsNodesArr.push(n); lsSaveOf(LS_NODES, lsNodesArr);
  nodes.push(n);
  return n;
}
async function apiUpdateNodeContent(id, content) {
  if (isTauri()) await mi("update_mindmap_node_content", { id, content });
  const n = nodes.find(v => v.id === id);
  if (n) n.content = content;
  const ln = lsNodesArr.find(v => v.id === id);
  if (ln) { ln.content = content; lsSaveOf(LS_NODES, lsNodesArr); }
}
async function apiUpdateNodePos(id, x, y) {
  if (isTauri()) await mi("update_mindmap_node_position", { id, x, y });
  const n = nodes.find(v => v.id === id);
  if (n) { n.x = x; n.y = y; }
  const ln = lsNodesArr.find(v => v.id === id);
  if (ln) { ln.x = x; ln.y = y; lsSaveOf(LS_NODES, lsNodesArr); }
}
async function apiDeleteNode(id) {
  if (isTauri()) await mi("delete_mindmap_node", { id });
  nodes = nodes.filter(n => n.id !== id);
  edges = edges.filter(e => e.from_id !== id && e.to_id !== id);
  lsNodesArr = lsNodesArr.filter(n => n.id !== id); lsSaveOf(LS_NODES, lsNodesArr);
  lsEdgesArr = lsEdgesArr.filter(e => e.from_id !== id && e.to_id !== id); lsSaveOf(LS_EDGES, lsEdgesArr);
}
async function apiListEdges(mapId) {
  const r = await mi("list_mindmap_edges", { mapId });
  if (r) return r;
  return lsEdgesArr.filter(e => e.map_id === mapId).slice();
}
async function apiAddEdge(mapId, fromId, toId) {
  const r = await mi("add_mindmap_edge", { mapId, fromId, toId });
  if (r) {
    edges.push(r);
    return r;
  }
  const id = (_lsIdSeq--);
  const e = { id, map_id: mapId, from_id: fromId, to_id: toId };
  lsEdgesArr.push(e); lsSaveOf(LS_EDGES, lsEdgesArr);
  edges.push(e);
  return e;
}
async function apiDeleteEdge(id) {
  if (isTauri()) await mi("delete_mindmap_edge", { id });
  edges = edges.filter(e => e.id !== id);
  lsEdgesArr = lsEdgesArr.filter(e => e.id !== id); lsSaveOf(LS_EDGES, lsEdgesArr);
}

/* ═══════════ 模式切换 ═══════════ */
function setMode(m) {
  if (mode === m) return;
  mode = m;
  tabTasks.classList.toggle("active", m === "tasks");
  tabMind.classList.toggle("active", m === "mind");
  tabImages.classList.toggle("active", m === "images");
  tabTasks.setAttribute("aria-selected", String(m === "tasks"));
  tabMind.setAttribute("aria-selected", String(m === "mind"));
  tabImages.setAttribute("aria-selected", String(m === "images"));
  // 侧栏列表
  newFolderBtn.hidden = m !== "tasks";
  folderListEl.hidden = m !== "tasks";
  modeBodyMind.hidden = m !== "mind";
  modeBodyImages.hidden = m !== "images";
  // 画布容器
  folderPane.hidden = m !== "tasks";
  mindPane.hidden = m !== "mind";
  imagePane.hidden = m !== "images";
  if (m === "mind") requestAnimationFrame(() => loadMaps());
  // 图片墙模块自行注册加载钩子（image-wall.js 里挂到 window），
  // 这里只负责在切到图片模式时触发，避免本模块反向依赖图片墙实现。
  if (m === "images") requestAnimationFrame(() => window.__loadImageWall && window.__loadImageWall());
}

/* ═══════════ 左侧：导图列表 ═══════════ */
/* 排序：手动拖拽顺序持久化在 localStorage（与任务夹 orderMap 一致的做法）。
   后端 list_mindmaps 返回按 created_at/id 升序的原始顺序，这里再按 orderMap
   覆盖显示顺序——orderMap 是唯一可信的视觉顺序来源。 */
let mapOrder = lsLoadOrder();
function cmpByOrder(a, b) {
  const oa = mapOrder[String(a.id)], ob = mapOrder[String(b.id)];
  if (oa == null && ob == null) return (a.created_at || 0) - (b.created_at || 0) || (a.id || 0) - (b.id || 0);
  if (oa == null) return 1;
  if (ob == null) return -1;
  return oa - ob;
}
async function loadMaps() {
  try { maps = await apiListMaps(); } catch { maps = []; }
  maps.sort(cmpByOrder);
  renderMapList();
  // 保留上一个选中的导图
  if (activeMapId && maps.find(m => m.id === activeMapId)) {
    setActiveMap(activeMapId);
  } else if (maps.length) {
    setActiveMap(maps[0].id);
  } else {
    setActiveMap(null);
  }
}
function renderMapList() {
  // 若某个导图正处于重命名输入中，跳过整体重绘——否则 input 被销毁会触发 blur，
  // 打断正在进行的提交，并把光标焦点一并丢掉了。
  // 注意：必须用 _renaming 标志，而不能用「列表里是否还存在 input」来判断——
  // 重命名刚提交/取消时 input 仍挂在 DOM 上，若据此 return 会导致列表永不重建，
  // 输入框卡住(回车后仍处于编辑态)、并遮挡住该导图名字。
  if (_renaming) return;
  mapListEl.innerHTML = "";
  for (const m of maps) {
    const li = document.createElement("li");
    li.className = "folder-item" + (m.id === activeMapId ? " active" : "");
    li.dataset.mapId = m.id;
    li.title = "拖动可调整位置 · 双击重命名";
    // li 不设 draggable="true"——WebView2 上 HTML5 DnD 会接管 pointer 事件流，
    // 导致下面的 pointerdown 拖动走不到 onUp（与任务夹列表同一处理）。
    li.setAttribute("draggable", "false");
    li.innerHTML =
      `<span class="drag-handle" title="拖动可调整位置">⋮⋮</span>` +
      `<span class="ico">🧠</span>` +
      `<span class="name">${esc(m.name)}</span>` +
      `<button class="rm" title="删除思维导图">×</button>`;
    li.addEventListener("click", e => {
      if (e.target.classList.contains("rm") || e.target.classList.contains("drag-handle")) return;
      if (_mapDragSuppressed) { _mapDragSuppressed = false; return; }
      setActiveMap(m.id);
    });
    li.addEventListener("dblclick", e => {
      if (e.target.classList.contains("rm")) return;
      startRenameMap(li, m);
    });
    li.querySelector(".rm").addEventListener("click", async e => {
      e.stopPropagation();
      const ok = await askConfirm(
        `确定删除思维导图「<b>${esc(m.name)}</b>」吗？<br/>其所有节点与连线将一并删除，此操作不可撤销。`,
        { title: "删除思维导图", okText: "删除" }
      );
      if (!ok) return;
      try {
        await apiDeleteMap(m.id);
        // 删除后从 orderMap 里清掉该项，避免旧 index 影响后续排序
        delete mapOrder[String(m.id)]; lsSaveOrder(mapOrder);
      } catch (err) {
        console.warn("[思维导图] 删除导图失败:", err);
      }
      if (activeMapId === m.id) await setActiveMap(null);
      await loadMaps();
    });
    // 拖动排序：pointer 模式（与任务夹列表一致）
    li.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      if (e.target.closest(".rm")) return;
      startMapPointerDrag(e, m.id, li);
    });
    mapListEl.appendChild(li);
  }
}
function startRenameMap(li, m) {
  const nameEl = li.querySelector(".name");
  const old = m.name;
  const input = document.createElement("input");
  input.value = old;
  input.className = "map-rename-input";
  input.maxLength = 30;
  nameEl.replaceWith(input);
  input.select();
  _renaming = true;
  let done = false;
  const commit = (save) => {
    if (done) return; done = true;
    _renaming = false;   // 先复位标志，renderMapList 才会真正重建（否则输入框永远清不掉）
    const val = (input.value || "").trim() || old;
    if (save && val !== old) {
      // apiRenameMap 是异步的：m.name 要在其内部 await 完成后才更新。
      // 必须把列表刷新放进 .then() 里，否则渲染发生在名字落库之前，界面仍是旧名。
      apiRenameMap(m.id, val).then(() => {
        if (m.id === activeMapId) renderMindHeader();
        renderMapList();
      });
    } else {
      renderMapList();
    }
  };
  input.addEventListener("blur", () => commit(true));
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    else if (e.key === "Escape") { commit(false); }
  });
}
/* 强制结束当前进行中的重命名（用于「新建导图」等会重建列表的操作前）。
   直接 blur 即可触发 commit → _renaming=false → 列表重建。 */
function finalizeRename() {
  const input = mapListEl.querySelector(".map-rename-input");
  if (!input) return;
  _renaming = false;
  input.blur();
}

/* 拖动思维导图到目标位置：把源插到目标之前/之后。
   与任务夹 reorderFolders 同思路——以当前 DOM 顺序为基准（DOM 就是刚渲染出的、
   最权威的视觉顺序），再按视觉顺序重算 mapOrder 让 index 从 0 连续递增。
   后端不存 sort_order，排序只持久化在 localStorage，切会话不丢。 */
function reorderMaps(srcId, targetId) {
  // 用 DOM 中的当前顺序作为基准
  const items = Array.from(mapListEl.querySelectorAll(".folder-item"))
    .map(li => Number(li.dataset.mapId));
  const srcIdx = items.indexOf(srcId);
  const tgtIdx = items.indexOf(targetId);
  if (srcIdx < 0 || tgtIdx < 0 || srcIdx === tgtIdx) return;

  // 落点在目标中线之上/下决定插入位置
  const tgtEl = mapListEl.querySelector(`li[data-map-id="${targetId}"]`);
  let pastMid = false;
  if (tgtEl) {
    const r = tgtEl.getBoundingClientRect();
    const isVertical = getComputedStyle(mapListEl).flexDirection !== "row";
    pastMid = isVertical
      ? (_mapDragY != null && _mapDragY > r.top + r.height / 2)
      : (_mapDragX != null && _mapDragX > r.left + r.width / 2);
  }

  items.splice(srcIdx, 1);
  let insertAt = items.indexOf(targetId);
  if (insertAt < 0) return;
  if (pastMid) insertAt += 1;
  items.splice(insertAt, 0, srcId);

  // 写回 orderMap：让 index 从 0 连续递增
  const order = {};
  items.forEach((id, i) => { order[String(id)] = i; });
  mapOrder = order; lsSaveOrder(mapOrder);

  // 关键：renderMapList 是按 maps 数组顺序渲染的，不是按 mapOrder。
  // 只更新 mapOrder 再 renderMapList 会让索引变了但列表文字序不变——
  // 视觉上「拖不动」。必须把 maps 数组重排成与 items(新视觉顺序)一致，再渲染。
  maps.sort((a, b) => items.indexOf(Number(a.id)) - items.indexOf(Number(b.id)));
  renderMapList();
}

/* 思维导图 pointer 排序：pointerdown + setPointerCapture + window pointermove/pointerup，
   与任务夹 startFolderPointerDrag 一致。不用 HTML5 DnD——WebView2 打包后 li 作为
   拖源不稳定，会让 pointermove/pointerup 不再触发。交互细节：
   - 4px 阈值内不当拖动，避免普通点击误触；
   - 移动时用 elementFromPoint 命中最近的 .folder-item，按鼠标相对中线挂
     fold-drop-before / fold-drop-after 显示插入指示线；
   - 松手按当前 hover 目标调用 reorderMaps。 */
function startMapPointerDrag(e, srcId, srcEl) {
  if (_mapDragSrc != null) return;
  // 若正在重命名（input 已替换掉 name），不要开启拖动——否则 blur 后 input 消失
  if (mapListEl.querySelector(".map-rename-input")) return;
  e.preventDefault();
  const startX = e.clientX, startY = e.clientY;
  const startElt = e.target;
  let activated = false;

  try { startElt.setPointerCapture(e.pointerId); } catch (_) {}

  const onMove = (ev) => {
    const dx = ev.clientX - startX, dy = ev.clientY - startY;
    if (!activated) {
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      activated = true;
      _mapDragSrc = srcId;
      _mapDragSrcEl = srcEl;
      srcEl.classList.add("fold-dragging");
      mapListEl.classList.add("reordering");
      _mapDragX = ev.clientX; _mapDragY = ev.clientY;
    }
    ev.preventDefault();
    _mapDragX = ev.clientX; _mapDragY = ev.clientY;
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const tgt = el ? (el.classList.contains("folder-item") ? el : el.closest(".folder-item")) : null;
    mapListEl.querySelectorAll(".fold-drop-before,.fold-drop-after").forEach(x => {
      x.classList.remove("fold-drop-before"); x.classList.remove("fold-drop-after");
    });
    if (!tgt || Number(tgt.dataset.mapId) === Number(srcId)) return;
    const r = tgt.getBoundingClientRect();
    const isVertical = getComputedStyle(mapListEl).flexDirection !== "row";
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
    const tgtId = tgt ? Number(tgt.dataset.mapId) : null;
    const wasDragging = activated;
    srcEl.classList.remove("fold-dragging");
    mapListEl.classList.remove("reordering");
    mapListEl.querySelectorAll(".fold-drop-before,.fold-drop-after").forEach(x => {
      x.classList.remove("fold-drop-before"); x.classList.remove("fold-drop-after");
    });
    _mapDragSrc = null; _mapDragSrcEl = null;
    if (wasDragging) {
      _mapDragSuppressed = true;   // 拖拽结束的 click 不再触发选图
      if (tgtId != null && tgtId !== Number(srcId)) reorderMaps(srcId, tgtId);
    }
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

/* ═══════════ 打开导图 ═══════════ */
async function setActiveMap(id) {
  // 若正有重命名输入框挂起，先提交它——否则 renderMapList 会因 _renaming 跳过重建，
  // 导致切图后 input 还挂在原列表项上、active 高亮不更新。
  finalizeRename();
  // 切换前先保存上一个导图的视野。必须在此刻捕获 id 与坐标到局部变量：
  // 下面的 activeMapId 会被覆盖，若依赖 saveViewDebounced 的闭包，
  // 定时器回调时读到的是新导图 id，旧视图会被错误地写到新导图上。
  const prevId = activeMapId;
  if (prevId != null) {
    clearTimeout(_viewTimer);
    const pv = { x: Math.round(view.x), y: Math.round(view.y), zoom: view.zoom };
    apiSaveView(prevId, pv.x, pv.y, pv.zoom);
  }
  activeMapId = id;
  activeMap = id != null ? (maps.find(m => m.id === id) || null) : null;
  selectedNodeId = null; selectedEdgeId = null; editingNode = null;
  renderMapList();
  if (!activeMap) {
    nodes = []; edges = []; renderMindCanvas();
    mindEmpty.innerHTML = `<b>还没有思维导图</b><br/>点击左侧「＋ 新建思维导图」开始创建`;
    mindEmpty.hidden = false;
    return;
  }
  view = { x: activeMap.pan_x != null ? activeMap.pan_x : 40, y: activeMap.pan_y != null ? activeMap.pan_y : 40, zoom: activeMap.zoom || 1 };
  try {
    nodes = await apiListNodes(id);
    edges = await apiListEdges(id);
  } catch { nodes = []; edges = []; }
  renderMindHeader();
  renderMindCanvas();
}
function renderMindHeader() {
  mindTitle.textContent = activeMap ? activeMap.name : "思维导图";
  mindMeta.textContent = activeMap ? `${nodes.length} 节点 · ${edges.length} 连线` : "";
  mindToolbar.hidden = !activeMap;
}

/* ═══════════ 画布渲染 ═══════════ */
function applyView() {
  mindWorld.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
  zoomLabel.textContent = Math.round(view.zoom * 100) + "%";
}
function renderMindCanvas() {
  applyView();
  if (!activeMap) {
    mindNodesWrap.innerHTML = "";
    mindEdgesSvg.innerHTML = "";
    mindEmpty.hidden = false;
    return;
  }
  // 节点
  nodeEls.clear();
  mindNodesWrap.innerHTML = "";
  for (const n of nodes) {
    const el = makeNodeEl(n);
    mindNodesWrap.appendChild(el);
  }
  renderEdges();
  // 空状态提示
  if (nodes.length === 0) {
    mindEmpty.innerHTML = `<b>双击空白处</b> 即可新建思维节点<br/>拖节点任意位置移动 · 单击文字编辑<br/>悬停节点显示连接点，从连接点拖到另一节点连线`;
    mindEmpty.hidden = false;
  } else {
    mindEmpty.hidden = true;
  }
}
function makeNodeEl(n) {
  const el = document.createElement("div");
  el.className = "mind-node" + (n.id === selectedNodeId ? " selected" : "");
  el.dataset.nodeId = n.id;
  el.style.left = n.x + "px";
  el.style.top = n.y + "px";
  el.innerHTML =
    `<div class="mind-port port-top" data-side="top"></div>` +
    `<div class="mind-port port-right" data-side="right"></div>` +
    `<div class="mind-port port-bottom" data-side="bottom"></div>` +
    `<div class="mind-port port-left" data-side="left"></div>` +
    `<div class="mind-node-body" contenteditable="false" spellcheck="false">${esc(n.content)}</div>` +
    `<button class="rm-node" title="删除节点">×</button>`;
  nodeEls.set(n.id, el);
  bindNodeEvents(el, n);
  return el;
}

/* ---------- 节点事件 ---------- */
function bindNodeEvents(el, n) {
  el.addEventListener("pointerdown", e => { downOnNode(e, el, n); });
  el.querySelector(".rm-node").addEventListener("click", e => {
    e.stopPropagation();
    removeNode(n.id);
  });
  el.querySelectorAll(".mind-port").forEach(port => {
    port.addEventListener("pointerdown", e => { startConnect(e, n); });
  });
  const body = el.querySelector(".mind-node-body");
  body.addEventListener("click", e => {
    e.stopPropagation();
    // 若刚拖完就不进编辑
    if (drag && drag.moved) return;
    selectNode(n.id);
    enterEdit(n, body);
  });
}
async function removeNode(id) {
  if (selectedNodeId === id) selectedNodeId = null;
  if (editingNode && editingNode.id === id) editingNode = null;
  await apiDeleteNode(id);   // 后端同步级联删除相关连线，API 内部会清理内存状态
  renderMindCanvas();
  renderMindHeader();
}

/* ---------- 选择 / 编辑 ---------- */
function selectNode(id) {
  selectedNodeId = id;
  selectedEdgeId = null;
  for (const [nid, el] of nodeEls) {
    el.classList.toggle("selected", nid === id);
  }
}
function enterEdit(n, body) {
  editingNode = n;
  selectedNodeId = n.id;
  body.setAttribute("contenteditable", "true");
  body.focus();
  // 光标移到最后
  const range = document.createRange();
  range.selectNodeContents(body);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  body.addEventListener("blur", () => exitEdit(n, body), { once: true });
}
async function exitEdit(n, body) {
  body.setAttribute("contenteditable", "false");
  editingNode = null;
  const content = body.textContent.trim();
  if (content !== (n.content || "")) {
    n.content = content;
    await apiUpdateNodeContent(n.id, content);
    renderMindHeader();
  }
  if (n.id === selectedNodeId) {
    const el = nodeEls.get(n.id);
    if (el) { const nb = el.querySelector(".mind-node-body"); nb.innerHTML = esc(content); }
  }
}

/* ---------- 节点拖拽 ---------- */
function downOnNode(e, el, n) {
  if (e.button !== 0) return;
  e.stopPropagation();
  // 正在编辑的节点：允许选择文字，不触发整节点拖动
  if (editingNode && editingNode.id === n.id && e.target.closest(".mind-node-body")) return;
  selectNode(n.id, el);
  const startX = e.clientX, startY = e.clientY;
  const oX = n.x, oY = n.y;
  drag = { kind: "node", moved: false, id: null };
  const onMove = ev => {
    if (!drag || drag.kind !== "node") return;
    const dx = ev.clientX - startX, dy = ev.clientY - startY;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    const nz = view.zoom;
    n.x = oX + dx / nz;
    n.y = oY + dy / nz;
    el.style.left = n.x + "px";
    el.style.top = n.y + "px";
    placeNodeOnTop(el, n);
    renderEdges();
  };
  const onUp = async () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    const moved = drag && drag.moved;
    drag = null;
    if (moved) { await apiUpdateNodePos(n.id, n.x, n.y); renderEdges(); }
  };
  placeNodeOnTop(el, n);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}
function placeNodeOnTop(el, n) {
  const top = nodeEls.get(n.id) || el;
  for (const [ , other] of nodeEls) {
    other.style.zIndex = other === top ? "3" : "2";
  }
  top.style.zIndex = "3";
}

/* ---------- 连线 ---------- */
function startConnect(e, node) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  e.stopImmediatePropagation();
  selectedNodeId = node.id;
  selectNode(node.id);
  connectingPort = { node, x: e.clientX, y: e.clientY };
  tempEdgeEl = document.createElementNS("http://www.w3.org/2000/svg", "path");
  tempEdgeEl.setAttribute("class", "mind-edge-temp");
  mindEdgesSvg.appendChild(tempEdgeEl);
  document.body.classList.add("is-dragging");
  updateTempEdge(e.clientX, e.clientY);
  const onMove = ev => { if (connectingPort) updateTempEdge(ev.clientX, ev.clientY); };
  const onUp = async ev => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    document.body.classList.remove("is-dragging");
    const from = connectingPort ? connectingPort.node : null;
    const toNode = hitTestNode(ev.clientX, ev.clientY);
    if (tempEdgeEl) { tempEdgeEl.remove(); tempEdgeEl = null; }
    connectingPort = null;
    if (from && toNode && from.id !== toNode.id) {
      await addEdge(from.id, toNode.id);
    }
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}
function updateTempEdge(cx, cy) {
  if (!connectingPort || !tempEdgeEl) return;
  const w1 = toWorld(cx, cy);
  const p0 = nodeCenter(connectingPort.node);
  tempEdgeEl.setAttribute("d", edgeCurvePath(p0.x, p0.y, w1.x, w1.y));
}
function nodeCenter(n) {
  const el = nodeEls.get(n.id);
  const h = el ? el.offsetHeight : 70;
  return { x: n.x + NODE_W / 2, y: n.y + h / 2 };
}
function edgeCurvePath(ax, ay, bx, by) {
  const cdx = Math.max(36, Math.abs(bx - ax) / 2);
  return `M${ax},${ay} C ${ax + cdx},${ay} ${bx - cdx},${by} ${bx},${by}`;
}
function edgePointOn(n, o) {
  const c1 = nodeCenter(n), c2 = nodeCenter(o);
  const el = nodeEls.get(n.id);
  const h = el ? el.offsetHeight : 70;
  const w = NODE_W;
  const dx = c2.x - c1.x, dy = c2.y - c1.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { x: n.x + w, y: c1.y } : { x: n.x, y: c1.y };
  }
  return dy >= 0 ? { x: c1.x, y: n.y + h } : { x: c1.x, y: n.y };
}
function edgePath(a, b) {
  const p1 = edgePointOn(a, b), p2 = edgePointOn(b, a);
  const cdx = Math.max(36, Math.abs(p2.x - p1.x) / 2);
  return `M${p1.x},${p1.y} C ${p1.x + cdx},${p1.y} ${p2.x - cdx},${p2.y} ${p2.x},${p2.y}`;
}
function hitTestNode(cx, cy) {
  const w = toWorld(cx, cy);
  let nearest = null, best = Infinity;
  for (const n of nodes) {
    const el = nodeEls.get(n.id);
    const h = el ? el.offsetHeight : 70;
    if (w.x >= n.x - 6 && w.x <= n.x + NODE_W + 6 && w.y >= n.y - 6 && w.y <= n.y + h + 6) {
      const d2 = (w.x - (n.x + NODE_W / 2)) ** 2 + (w.y - (n.y + h / 2)) ** 2;
      if (d2 < best) { best = d2; nearest = n; }
    }
  }
  return nearest;
}
async function addEdge(fromId, toId) {
  // 避免重复边
  if (edges.some(e => (e.from_id === fromId && e.to_id === toId) || (e.from_id === toId && e.to_id === fromId))) return;
  const e = await apiAddEdge(activeMapId, fromId, toId);
  if (e) { renderEdges(); renderMindHeader(); }
}
function renderEdges() {
  if (!activeMap) { mindEdgesSvg.innerHTML = ""; return; }
  mindEdgesSvg.innerHTML = "";
  for (const e of edges) {
    const a = nodes.find(n => n.id === e.from_id);
    const b = nodes.find(n => n.id === e.to_id);
    if (!a || !b) continue;
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", "mind-edge" + (e.id === selectedEdgeId ? " selected" : ""));
    g.dataset.edgeId = e.id;
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("class", "mind-edge-path");
    p.setAttribute("d", edgePath(a, b));
    const hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
    hit.setAttribute("class", "mind-edge-hit");
    hit.setAttribute("d", edgePath(a, b));
    g.appendChild(p);
    g.appendChild(hit);
    g.addEventListener("click", ev => {
      ev.stopPropagation();
      selectEdge(e.id);
    });
    mindEdgesSvg.appendChild(g);
  }
}
function selectEdge(id) {
  selectedEdgeId = id;
  selectedNodeId = null;
  for (const [ , el] of nodeEls) el.classList.remove("selected");
  const ge = mindEdgesSvg.querySelector(`.mind-edge[data-edge-id="${id}"]`);
  mindEdgesSvg.querySelectorAll(".mind-edge").forEach(g => g.classList.toggle("selected", g === ge));
}
async function deleteEdge(id) {
  if (selectedEdgeId === id) selectedEdgeId = null;
  await apiDeleteEdge(id);
  renderEdges();
  renderMindHeader();
}

/* ---------- 坐标换算 ---------- */
function canvasRect() { return mindCanvas.getBoundingClientRect(); }
function toWorld(cx, cy) {
  const r = canvasRect();
  return { x: (cx - r.left - view.x) / view.zoom, y: (cy - r.top - view.y) / view.zoom };
}

/* ---------- 新建节点 ---------- */
async function createNodeAt(wx, wy, content) {
  const n = await apiCreateNode(activeMapId, content || "", wx, wy);
  if (!n) return null;
  mindEmpty.hidden = true;
  renderEdges();
  renderMindHeader();
  // 定位到 DOM 并进入编辑
  const existing = nodeEls.get(n.id);
  if (existing) existing.remove();
  const el = makeNodeEl(n);
  mindNodesWrap.appendChild(el);
  selectNode(n.id);
  enterEdit(n, el.querySelector(".mind-node-body"));
  return n;
}

/* ---------- 缩放 / 平移 ---------- */
function zoomBy(factor, cx, cy) {
  const r = canvasRect();
  const wx = cx != null ? (cx - r.left - view.x) / view.zoom : 0;
  const wy = cy != null ? (cy - r.top - view.y) / view.zoom : 0;
  const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * factor));
  if (nz === view.zoom) return;
  if (cx != null) {
    view.x = cx - r.left - wx * nz;
    view.y = cy - r.top - wy * nz;
  }
  view.zoom = nz;
  applyView();
  saveViewDebounced(400);
}
function fitView() {
  if (!activeMap || !nodes.length) return;
  const r = canvasRect();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const el = nodeEls.get(n.id);
    const h = el ? el.offsetHeight : 70;
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + NODE_W); maxY = Math.max(maxY, n.y + h);
  }
  const margin = 60;
  const zx = (r.width - margin * 2) / (maxX - minX || 1);
  const zy = (r.height - margin * 2) / (maxY - minY || 1);
  view.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(zx, zy, 1.2)));
  view.x = r.width / 2 - ((minX + maxX) / 2) * view.zoom;
  view.y = r.height / 2 - ((minY + maxY) / 2) * view.zoom;
  applyView();
  saveViewDebounced(400);
}
function saveViewDebounced(delay) {
  if (!activeMap) return;
  clearTimeout(_viewTimer);
  _viewTimer = setTimeout(() => {
    apiSaveView(activeMapId, Math.round(view.x), Math.round(view.y), view.zoom);
  }, delay || 300);
}

/* ---------- 画布：平移 / 双击建点 / 滚轮缩放 ---------- */
function bindCanvasEvents() {
  mindCanvas.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    if (e.target !== mindCanvas && e.target !== mindWorld && !e.target.closest(".mind-empty")) return;
    // 空白处：开始平移
    const sx = e.clientX, sy = e.clientY;
    const ox = view.x, oy = view.y;
    const wasEmpty = e.target === mindCanvas || e.target === mindWorld;
    if (!wasEmpty) return;
    mindCanvas.classList.add("panning");
    document.body.classList.add("is-dragging");
    drag = { kind: "pan", moved: false };
    selectedNodeId = null; selectedEdgeId = null;
    deselectAll();
    const onMove = ev => {
      if (!drag || drag.kind !== "pan") return;
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      view.x = ox + dx;
      view.y = oy + dy;
      applyView();
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      mindCanvas.classList.remove("panning");
      document.body.classList.remove("is-dragging");
      const moved = drag && drag.moved;
      drag = null;
      if (moved) saveViewDebounced();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });
  mindCanvas.addEventListener("dblclick", e => {
    if (!activeMap) return;
    if (e.target.closest(".mind-node")) return;
    const w = toWorld(e.clientX, e.clientY);
    createNodeAt(w.x - 60, w.y - 25, "");
  });
  mindCanvas.addEventListener("wheel", e => {
    if (!activeMap) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9091;
    zoomBy(factor, e.clientX, e.clientY);
  }, { passive: false });
  mindCanvas.addEventListener("click", e => {
    if (e.target === mindCanvas || e.target === mindWorld) { deselectAll(); }
  });
}
function deselectAll() {
  selectedNodeId = null; selectedEdgeId = null;
  for (const [ , el] of nodeEls) el.classList.remove("selected");
  mindEdgesSvg.querySelectorAll(".mind-edge").forEach(g => g.classList.remove("selected"));
}

/* ---------- 工具栏 / 键盘 ---------- */
function bindToolbar() {
  zoomInBtn.addEventListener("click", e => zoomBy(1.1, e.clientX, e.clientY));
  zoomOutBtn.addEventListener("click", e => zoomBy(0.9091, e.clientX, e.clientY));
  fitBtn.addEventListener("click", fitView);
}
/* 确认弹窗：确定/取消按钮 + 点击遮罩关闭 + Enter/Escape 快捷键。
   事件在 init 里注册一次，全局复用；askConfirm 每次只显示/隐藏。 */
function bindConfirm() {
  confirmOkBtn.addEventListener("click", () => closeConfirm(true));
  confirmCancelBtn.addEventListener("click", () => closeConfirm(false));
  confirmModal.addEventListener("click", e => {
    if (e.target === confirmModal) closeConfirm(false);
  });
  document.addEventListener("keydown", e => {
    if (confirmModal.hidden) return;
    if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); closeConfirm(true); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeConfirm(false); }
  }, true);
}
function bindKeyboard() {
  document.addEventListener("keydown", e => {
    if (mindPane.hidden || !activeMap) return;
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    const ae = document.activeElement;
    if (ae && (ae.isContentEditable || ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) return;
    if (selectedEdgeId != null) { e.preventDefault(); deleteEdge(selectedEdgeId); }
    else if (selectedNodeId != null) { e.preventDefault(); removeNode(selectedNodeId); }
  });
}

/* ---------- 初始化 ---------- */
function bindModeTabs() {
  tabTasks.addEventListener("click", () => setMode("tasks"));
  tabMind.addEventListener("click", () => setMode("mind"));
  tabImages.addEventListener("click", () => setMode("images"));
}
async function init() {
  newMapBtn.addEventListener("click", async () => {
    // 若上一张导图的重命名还停着（未回车/未失焦），先提交关闭，否则 _renaming
    // 会让 renderMapList 跳过重建，导致新建的导图不在列表里，且旧输入框仍遮挡名字。
    finalizeRename();
    const m = await apiCreateMap("");
    maps.push(m);
    await setActiveMap(m.id);   // 内部会 renderMapList，并激活新导图
    // 立即进入名称编辑，给用户「新建即改名」的体验
    const li = mapListEl.querySelector(`li[data-map-id="${m.id}"]`);
    if (li) startRenameMap(li, m);
  });
  bindModeTabs();
  bindCanvasEvents();
  bindToolbar();
  bindConfirm();
  bindKeyboard();
}
init();