// ============================================================
// chat-sidepanel.js — 右侧面板（Diff + 子任务 + 待办）
// 依赖：core/state.js、core/utils.js（escapeHtml, showToast, getActiveMessagesEl, getCachedMessages,
//       normalizeMessageItem, isInternalUserMessage, safeText）、core/apicall.js（api）、
//       chat/render.js（buildMessageNode, setRenderTodosHandler）
// ============================================================

import { api } from '../core/apicall.js';
import { store, currentDir } from '../core/state.js';
import { escapeHtml, showToast, showApiError, getActiveMessagesEl, getCachedMessages, modelDisplayLabel, setTodoPanelRefreshHandler, copyToClipboard, bindOverlayClose } from '../core/utils.js';
import { adaptMessages, formatApiError, unwrapList, nextCursor, normalizeStatuses } from '../core/v2compat.js';
// 时间格式化统一走 core/format.js
import { formatSubtaskDuration, formatMinuteTime } from '../core/format.js';
import { buildMessageNode, setRenderTodosHandler } from './render.js';
// 复用权限模块已有的 parentID 回溯缓存：子会话活动事件按 child -> parent 定位父面板时使用。
// 该模块只依赖 core 层，不构成循环导入。
import { resolveOpenOwner } from './permission.js';

// 向 render.js 注入"消息渲染完成后刷新待办面板"的回调（sidepanel→render 单向依赖，无环）。
// 同时向 core 层注册"待办面板刷新"入口：service.js 在服务状态变化后触发。
// renderTodos 定义于本文件下方（函数声明提升）。
// 注意：session→tabs→events→session 仍存在跨模块环（顶层均无立即跨模块调用，运行时函数调用安全），
// 且 sidepanel 被 session 依赖、又依赖 render——渲染期注入仍需延迟到微任务，避免模块初始化 TDZ。
queueMicrotask(() => {
    setRenderTodosHandler(renderTodos);
    setTodoPanelRefreshHandler(renderTodos);
});

// ============================
// 待办事项 — 从消息中提取并渲染
// ============================

// 待办事项所用的工具名。
// OpenCode 2.1.0 起内置 `todowrite`（需配置 experimental.todo: true），
// 数据在 tool part 的 state.input.todos；同时兼容旧插件 todo_write 与自定义同名工具。
const TODO_TOOL_NAMES = ['todowrite', 'todo_write', 'todo'];

/** 从当前会话的缓存消息中提取待办事项列表 */
export function extractTodos() {
    const items = getCachedMessages(store.currentSessionId);
    if (!items.length) return [];
    for (let i = items.length - 1; i >= 0; i--) {
        const info = items[i].info || items[i];
        if (info.role !== 'assistant') continue;
        const parts = items[i].parts || [];
        for (let j = parts.length - 1; j >= 0; j--) {
            const part = parts[j];
            if (part.type !== 'tool') continue;
            const toolName = part.tool || part.name || '';
            if (!TODO_TOOL_NAMES.includes(toolName)) continue;
            const state = part.state || {};
            // v1 放在 state.input.todos；兼容 state.todos 与 v2 的 content 形态
            const todos = (state.input && state.input.todos)
                || state.todos
                || (Array.isArray(state.content) ? state.content : null);
            if (Array.isArray(todos)) return todos;
        }
    }
    return [];
}

/** 渲染待办事项面板
 *
 *  OpenCode 2.1.0 起内置 todowrite（experimental.todo），面板常显，无数据时显示
 *  「会话中暂无待办」。
 *  数据来源：模型调用 todowrite 后，从会话消息的 tool part 提取
 *  state.input.todos（见 extractTodos）；刷新时机：消息渲染后（render.js 回调）
 *  与服务状态变化后（service.js 经 core/utils.js 的刷新通道）。 */
export function renderTodos() {
    const box = document.getElementById('ocTodos');
    if (!box) return;

    const todos = extractTodos();
    if (!todos.length) {
        box.innerHTML = '<div class="empty-state empty-state--sm">会话中暂无待办</div>';
        return;
    }
    // 按 OpenCode 的三种状态分组：进行中 / 待处理 / 已完成（含 cancelled）。
    // 之前 pending 与 in_progress 混在「进行中」下，导致 6 项全显示为进行中。
    const inProgress = todos.filter(t => t.status === 'in_progress');
    const pending = todos.filter(t => !t.status || t.status === 'pending');
    const completed = todos.filter(t => t.status === 'completed' || t.status === 'cancelled');
    if (!inProgress.length && !pending.length && !completed.length) {
        box.innerHTML = '<div class="empty-state empty-state--sm">会话中暂无待办</div>';
        return;
    }

    let html = '';
    const priorityClass = { high: 'pri-high', medium: 'pri-medium', low: 'pri-low' };

    const renderGroup = (label, list, done) => {
        if (!list.length) return;
        html += `<div class="oc-todo-group"><div class="oc-todo-group-label">${label}</div>`;
        list.forEach(t => {
            const pri = priorityClass[t.priority] || '';
            if (done) {
                html += `<div class="oc-todo-item done ${pri}" title="${escapeHtml(t.content)}">`;
                html += `<span class="oc-todo-check"><svg class="i" aria-hidden="true"><use href="#i-check"></use></svg></span>`;
            } else {
                html += `<div class="oc-todo-item ${pri}" title="${escapeHtml(t.content)}">`;
                html += `<span class="oc-todo-check" data-content="${escapeHtml(t.content)}"></span>`;
            }
            html += `<span class="oc-todo-text">${escapeHtml(t.content)}</span></div>`;
        });
        html += '</div>';
    };

    renderGroup('进行中', inProgress, false);
    renderGroup('待处理', pending, false);
    renderGroup('已完成', completed, true);

    box.innerHTML = html;
}


// ============================================================
// 子任务面板 — 数据源：服务端 child sessions 列表
// 原实现扫描「消息缓存」里的 subagent/task tool parts，先天不足：
//   1) 打开会话只拉最近 20 条消息（loadMessages），最近 20 条里没有 subagent 时
//      面板为空——即使会话历史里有大量子任务；
//   2) 滚动加载更早消息（loadOlderMessages）写入缓存后不会触发重新提取；
//   3) 只有发送消息后的 SSE 流事件才重新提取，导致「发消息后历史子任务突然出现」。
// 现改为直接查询服务端 child sessions 列表（GET /api/session?parentID=，权威全量、
// 一次一请求按游标翻页），与消息缓存彻底解耦。
// ============================================================

/** 子任务列表拉取节流窗口（毫秒）：消息 part 的 SSE 事件高频到来，
 *  面板数据源改为网络请求后必须节流合并，避免请求风暴。 */
const SUBTASK_REFRESH_THROTTLE_MS = 900;

/** 子任务列表翻页上限（防御服务端游标异常导致死循环；默认 50 条/页，5 页 = 250 条） */
const SUBTASK_MAX_PAGES = 5;

/** 面板刷新节流状态：上次发起请求时间 / 请求在途 / 有待执行的新一轮刷新 / 等待定时器句柄 */
let subtaskRefreshLastAt = 0;
let subtaskRefreshInFlight = false;
let subtaskRefreshQueued = false;
let subtaskRefreshTimer = 0;
/** 面板刷新轮次序号：用于丢弃过期请求的结果（快速切会话 / 连续刷新时） */
let subtaskPanelRefreshSeq = 0;

// 子任务详情消息全量读取：v2 消息接口是游标分页，单次请求只返回默认一页。
const SUBTASK_MESSAGE_PAGE = 200;      // 单页条数，与主会话向上翻页一致
const SUBTASK_MESSAGE_MAX_PAGES = 50;  // 防御上限：最多 1 万条，避免游标异常时死循环

/** child session 的 outcome → 面板状态键（renderSubtaskCard/fillModalSummary 使用）：
 *  服务端仅提供 succeeded / failed / interrupted；进行中的子任务没有 outcome 字段。 */
const CHILD_SESSION_STATUS_MAP = {
    succeeded: 'completed',
    failed: 'error',
    interrupted: 'interrupt',
};

/** 子任务的父会话关系缓存：childSessionId -> parentSessionId。
 *  来源有两个：refreshSubtaskPanel 拉取 child sessions 列表时写入；
 *  子会话活动事件找不到关系时，经 permission.js 的 resolveOpenOwner 回溯 parentID 后写入。
 *  目的：子会话的 SSE 事件只带自己的 sessionID，需要据此定位并刷新当前父会话的面板。 */
const subtaskParentByChild = new Map();

/** 正在异步回溯父子关系的 child ID 集合（防重入）。
 *  子会话 tool delta 事件非常密集；关系未知时只允许一个查询在途，后续事件直接跳过，
 *  避免每个 delta 都向 /api/session/{child} 打一次请求。 */
const subtaskParentResolving = new Set();

/** 本轮运行的起始时间缓存：childSessionId -> 前端首次观察到它处于 active 的时间戳。
 *  子会话被复用（已完成后再运行）时，服务端 time.created 仍是首次创建时间，
 *  不能用来计算本次时长；这里以「本轮首次观察 active」作为这一轮的起点。 */
const subtaskRunStartedAt = new Map();

/** 已结束的「本轮运行」记录：childSessionId -> { startedAt, endedAt, durationMs }。
 *  子会话退出 active 时把「本轮起点 -> 退出时刻」保存于此，刷新时继续显示本次时长，
 *  避免回落到 created→updated 的整个历史生命周期；弹窗的开始/结束时间也使用本轮时间。 */
const subtaskFinishedRun = new Map();

/** 把多种形态的活跃状态输入归一成 child session ID 集合（纯函数）。
 *  接受 Set / 数组 / 对象：
 *   - Set/数组：直接视为活跃 ID；
 *   - 对象：兼容 /api/session/active 的原始形态 {sid:{type:'running'}}，
 *     也兼容 normalizeStatuses 之后的 {sid:'busy'}。
 *  仅 running/busy/retry/true 视为活跃；idle、未知值一律忽略。 */
export function normalizeActiveSessionIds(activeStatuses) {
    const ids = new Set();
    if (!activeStatuses) return ids;
    if (activeStatuses instanceof Set) {
        activeStatuses.forEach(function(id) {
            if (typeof id === 'string' && id) ids.add(id);
        });
        return ids;
    }
    if (Array.isArray(activeStatuses)) {
        activeStatuses.forEach(function(id) {
            if (typeof id === 'string' && id) ids.add(id);
        });
        return ids;
    }
    if (typeof activeStatuses !== 'object') return ids;
    Object.keys(activeStatuses).forEach(function(id) {
        const value = activeStatuses[id];
        const key = (value && typeof value === 'object')
            ? (value.type != null ? value.type : value.status)
            : value;
        if (key === true || key === 'running' || key === 'busy' || key === 'retry') ids.add(id);
    });
    return ids;
}

/** 把服务端 child session 数组归一化为面板卡片摘要（纯函数，便于单测）。
 *  activeStatuses（可选）是当前活跃会话集合（Set/数组/对象，见 normalizeActiveSessionIds）：
 *  active 中的 child 必须覆盖历史 outcome，强制标记为 running——
 *  已完成子会话被复用再次运行时，服务端 outcome 仍是 succeeded，不能据此显示「已完成」。
 *  非 active 的子会话保持 outcome 映射（completed/error/interrupt）不变。
 *  字段逐一对应 renderSubtaskCard / fillModalSummary 的读取项：
 *  - childSessionId/title/agent/model/status/durationMs 来自列表字段；
 *  - 列表没有消息上下文（parentMessageId/taskPartId）与输入输出预览，置空串——
 *    卡片点击改走「消息缓存反查」（findCachedSubtaskPart）定位父消息，
 *    反查未命中时打开详情弹窗兜底，不再依赖这两个字段（见 onSubtaskCardClick）。
 *  输出顺序：按 time.updated 降序（新→旧，最新在最上面）。 */
export function mapChildSessionsToSummaries(list, activeStatuses) {
    const children = Array.isArray(list) ? list : [];
    const activeIds = normalizeActiveSessionIds(activeStatuses);
    // 面板排序：按 time.updated 降序（后执行的在前、**最新在最上面**）。
    // 缺 time.updated 的项以 0 参与比较（排最后）；slice() 复制副本，避免修改调用方数组。
    const sorted = children.slice().sort((a, b) => (Number(b?.time?.updated) || 0) - (Number(a?.time?.updated) || 0));
    return sorted.map(s => {
        const created = Number(s?.time?.created);
        const updated = Number(s?.time?.updated);
        const hasTime = Number.isFinite(created) && Number.isFinite(updated);
        const providerID = s?.model?.providerID || '';
        const modelID = s?.model?.id || '';
        const modelRef = (providerID && modelID) ? (providerID + '/' + modelID) : '';
        const childSessionId = s?.id || '';
        // 活跃快照优先级最高：已完成子会话被复用再次运行时 outcome 仍是 succeeded，
        // 只凭 outcome 会把正在运行的卡片误显示为「已完成」。
        const isActive = !!childSessionId && activeIds.has(childSessionId);
        // outcome 是 v2 会话「结束」时才落盘的字段，缺失时必须区分两种情形：
        //  - v2 会话（创建时即带 permissions 配置）→ outcome 还没写 = 仍在运行中；
        //  - v1 时代继承的旧会话（无 permissions，永远不会写 outcome）→ 中性「已结束」。
        const outcomeStatus = s?.outcome
            ? (CHILD_SESSION_STATUS_MAP[s.outcome] || 'running')
            : (Array.isArray(s?.permissions) ? 'running' : 'ended');
        return {
            childSessionId: childSessionId,
            title: s?.title || '未知任务',
            description: '',
            agent: s?.agent || 'unknown',
            model: modelRef ? modelDisplayLabel(modelRef) : 'unknown',
            status: isActive ? 'running' : outcomeStatus,
            // durationMs 不在这里用 created→updated 拼「生命周期」：运行中的时长由
            // applySubtaskRunTiming 按本轮首次 active 观察时间计算；已完成项优先使用
            // 本轮观察到的时长，只有从未观察过运行的旧历史项才保留服务端时间差兜底。
            durationMs: isActive ? null : (hasTime ? (updated - created) : null),
            interrupted: !isActive && s?.outcome === 'interrupted',
            // 运行中卡片必须使用本轮起点；其余情况先给服务端时间，后续由计时叠加层覆盖。
            startedAt: isActive ? null : (hasTime ? created : null),
            endedAt: isActive ? null : (hasTime ? updated : null),
            outputPreview: '',
            promptPreview: '',
            parentMessageId: '',
            taskPartId: '',
        };
    });
}

/** 取子任务查询所需的当前会话目录：优先现有目录来源（store.sessionMap 等，见 currentDir()），
 *  拿不到时兜底请求会话详情的 location.directory。
 *  返回空串时调用方必须跳过请求——child sessions 查询缺 location 会回落到服务端进程
 *  CWD（共享服务为 home）并把该目录误登记成项目。 */
async function resolveSubtaskDirectory(sessionId) {
    const dir = currentDir();
    if (dir) return dir;
    try {
        const res = await api.OpenCodeCall('GET', '/api/session/' + encodeURIComponent(sessionId));
        const data = (res && typeof res === 'object' && 'data' in res && res.data && typeof res.data === 'object')
            ? res.data
            : res;
        const directory = data && data.location && data.location.directory;
        return typeof directory === 'string' ? directory.trim() : '';
    } catch (_) {
        return '';
    }
}

/** 拉取某父会话的全部 child sessions（服务端权威列表；按游标翻页，上限 SUBTASK_MAX_PAGES 页防御）。
 *  响应形如 {data:[...], cursor:{next}}；实测数据已尽时仍可能签发 next，故「空页」同样终止翻页。 */
async function fetchChildSessions(directory, parentSessionId) {
    const all = [];
    let cursor = '';
    for (let page = 0; page < SUBTASK_MAX_PAGES; page++) {
        let path = '/api/session?parentID=' + encodeURIComponent(parentSessionId);
        if (cursor) path += '&cursor=' + encodeURIComponent(cursor);
        // 第 4 参由 api.OpenCodeCall 统一追加 location[directory]（与 service.js 的调用风格一致）
        const res = await api.OpenCodeCall('GET', path, null, directory);
        const list = unwrapList(res);
        if (!list.length) break; // 空页 = 已到末尾
        all.push(...list);
        cursor = nextCursor(res) || '';
        if (!cursor) break;
    }
    return all;
}

/** 拉取当前活跃会话 ID 集合（GET /api/session/active）。
 *  v2 返回 {data:{sid:{type:'running'}}}，只列出活跃会话；这里复用 normalizeStatuses
 *  转成 v1 契约后，再筛出 running/busy/retry 的会话 ID。
 *  请求失败返回 null：调用方不得据此改写任何状态，只保持历史 outcome 映射。 */
async function fetchActiveSessionIds() {
    try {
        const statuses = normalizeStatuses(await api.OpenCodeCall('GET', '/api/session/active'));
        return normalizeActiveSessionIds(statuses);
    } catch (_) {
        return null;
    }
}

/** 为面板摘要叠加「本轮运行」计时（就地修改 summaries，不影响纯函数映射）。
 *  - 运行中：首次观察到 active 时记录起点，之后每次刷新沿用同一起点（不随刷新重置）；
 *  - 退出 active：删除起点，把「起点 -> 退出观察时刻」保存为本轮时长；
 *  - active 快照请求失败（null/未提供 Set）：不能把已有 subtaskRunStartedAt
 *    当成已结束，保持 running 与本轮起点；只有明确快照（Set，含空 Set）才判定退出。
 *  这样复用已完成子会话再次运行时，不会把 created→updated 的整个历史生命周期当成本次时长。 */
export function applySubtaskRunTiming(summaries, activeIds) {
    const now = Date.now();
    const list = Array.isArray(summaries) ? summaries : [];
    for (const s of list) {
        const id = s && s.childSessionId;
        if (!id) continue;
        // activeIds 必须是 Set 才代表「已成功取得的明确快照」（空 Set 也有效）。
        // null/undefined 表示状态查询失败或未提供：此时不能凭 status/outcome 判退出，
        // 已在 subtaskRunStartedAt 中的 child 继续视为运行中。
        const hasActiveSnapshot = activeIds instanceof Set;
        const isRunning = s.status === 'running'
            || (hasActiveSnapshot ? activeIds.has(id) : subtaskRunStartedAt.has(id));
        if (isRunning) {
            // 新一轮运行（包括复用已完成子会话）：清掉上一轮保存的记录，重新计时。
            subtaskFinishedRun.delete(id);
            if (!subtaskRunStartedAt.has(id)) subtaskRunStartedAt.set(id, now);
            const startedAt = subtaskRunStartedAt.get(id);
            s.status = 'running';
            s.startedAt = startedAt;
            s.endedAt = null;
            s.durationMs = Math.max(0, now - startedAt);
            continue;
        }
        if (subtaskRunStartedAt.has(id)) {
            // 本轮刚退出 active：以退出观察时刻作为本次结束时间，保存本轮时长。
            const startedAt = subtaskRunStartedAt.get(id);
            const record = { startedAt: startedAt, endedAt: now, durationMs: Math.max(0, now - startedAt) };
            subtaskRunStartedAt.delete(id);
            subtaskFinishedRun.set(id, record);
            s.startedAt = record.startedAt;
            s.endedAt = record.endedAt;
            s.durationMs = record.durationMs;
        } else if (subtaskFinishedRun.has(id)) {
            // 已完成项继续显示本轮观察到的起止时间/时长（不重新用 created→updated 覆盖）。
            const record = subtaskFinishedRun.get(id);
            s.startedAt = record.startedAt;
            s.endedAt = record.endedAt;
            s.durationMs = record.durationMs;
        }
    }
}

/** 刷新子任务面板：拉取并渲染当前会话的 child sessions 列表。
 *  调用方：会话打开/切换/刷新（session.js、tabs.js）与节流调度（scheduleSubtaskExtraction）。
 *  同时拉取 /api/session/active：active 中的 child 覆盖历史 outcome（修复复用已完成
 *  子会话再次运行时仍显示「已完成」的问题）。
 *  失败静默：请求异常时保留面板现状（仅 console 记录），不弹 toast。 */
export async function refreshSubtaskPanel() {
    const sessionId = store.currentSessionId;
    // 服务未运行 / 未选择会话：沿用既有空态（清空数据并渲染）
    if (!store.webRunning || !sessionId) {
        store.subtaskSummaries = [];
        renderSubtaskPanel();
        return;
    }
    const seq = ++subtaskPanelRefreshSeq;
    try {
        const dir = await resolveSubtaskDirectory(sessionId);
        if (!dir) return; // 无目录不请求（避免服务端回落到 CWD=home）
        // child sessions 与 active 快照并行拉取：两者都返回后才统一叠加状态，避免中间态。
        const [children, activeIds] = await Promise.all([
            fetchChildSessions(dir, sessionId),
            fetchActiveSessionIds(),
        ]);
        // 竞态保护：结果返回时刷新目标已变化（切了会话 / 又发起了新一轮刷新）→ 丢弃本次结果
        if (seq !== subtaskPanelRefreshSeq || sessionId !== store.currentSessionId) return;
        // 记录 child -> parent 关系：子会话活动事件据此刷新当前父面板（无需额外查询）。
        children.forEach(function(child) {
            if (child && child.id) subtaskParentByChild.set(child.id, sessionId);
        });
        // active 查询失败（null）≠ 当前没有活跃会话：不能用历史 outcome 覆盖
        // 本客户端已观察到的运行态。把已知运行中的 child 作为状态覆盖集合传给
        // 纯函数；applySubtaskRunTiming 仍接收原始 activeIds，保持「失败不结束计时」语义。
        const statusActiveIds = activeIds === null
            ? new Set(subtaskRunStartedAt.keys())
            : activeIds;
        const summaries = mapChildSessionsToSummaries(children, statusActiveIds);
        applySubtaskRunTiming(summaries, activeIds);
        store.subtaskSummaries = summaries;
        renderSubtaskPanel();
    } catch (err) {
        console.warn('刷新子任务面板失败（保留面板现状）:', err);
    }
}

/** 标记「面板需要刷新」，按节流窗口择机发起（合并高频事件） */
function queueSubtaskPanelRefresh() {
    subtaskRefreshQueued = true;
    flushSubtaskPanelRefresh();
}

/** 尝试消耗「待刷新」标记：满足「无在途请求 + 距上次请求超过节流窗口」才真正发起；
 *  否则等窗口到期（定时器）或当前请求结束（finally 回调）后再试，保证最后一次事件被拉取。 */
function flushSubtaskPanelRefresh() {
    if (!subtaskRefreshQueued || subtaskRefreshInFlight) return;
    const wait = SUBTASK_REFRESH_THROTTLE_MS - (Date.now() - subtaskRefreshLastAt);
    if (wait > 0) {
        if (!subtaskRefreshTimer) {
            subtaskRefreshTimer = setTimeout(() => {
                subtaskRefreshTimer = 0;
                flushSubtaskPanelRefresh();
            }, wait);
        }
        return;
    }
    subtaskRefreshQueued = false;
    subtaskRefreshInFlight = true;
    subtaskRefreshLastAt = Date.now();
    refreshSubtaskPanel().finally(() => {
        subtaskRefreshInFlight = false;
        flushSubtaskPanelRefresh(); // 在途期间又收到事件 → 尾随补拉一次
    });
}

/** 调度子任务面板刷新到下一帧（对 events.js 的调用点保持原语义：传入会话 ID）。
 *  相对旧实现的唯一变化：数据源从「消息缓存扫描」改为「服务端 child sessions 拉取」，
 *  因此叠加了请求节流（见 queueSubtaskPanelRefresh），避免消息 part 高频事件轰炸 API。 */
export function scheduleSubtaskExtraction(sessionID) {
    if (!sessionID || sessionID !== store.currentSessionId) return;
    if (store.subtaskExtractionPending) return;
    store.subtaskExtractionPending = true;
    store.subtaskExtractionFrame = requestAnimationFrame(() => {
        store.subtaskExtractionFrame = 0;
        store.subtaskExtractionPending = false;
        queueSubtaskPanelRefresh();
    });
}

/** 子会话活动触发的父面板刷新入口（events.js 在 isBusyActivityEvent / execution.* 时调用）。
 *  子任务的 SSE 事件带的是 child sessionID，不是当前父会话 ID；旧逻辑在这里直接丢弃，
 *  导致复用已完成子会话再次运行时父面板一直停留在「已完成」。
 *  解析顺序（尽量零请求）：
 *   1) 自身就是当前会话 → 直接走既有节流刷新；
 *   2) 已知 child -> parent 关系（列表刷新时缓存）→ 父会话是当前会话才刷新；
 *   3) 当前摘要列表里能找到该 child → 直接认定父会话为当前会话并补缓存；
 *   4) 关系未知 → 经 permission.js 的 resolveOpenOwner 回溯 parentID；该模块自带
 *      descendantCache（按 openTabs 签名），每个子会话最多一次网络查询，后续事件命中缓存。
 *  真正的面板请求仍然统一走 scheduleSubtaskExtraction 的 RAF + 900ms 节流，
 *  不会因为每个 tool delta 而发请求。 */
export function scheduleSubtaskActivityRefresh(sessionID) {
    if (!sessionID) return;
    if (sessionID === store.currentSessionId) {
        scheduleSubtaskExtraction(sessionID);
        return;
    }
    const knownParent = subtaskParentByChild.get(sessionID);
    if (knownParent) {
        if (knownParent === store.currentSessionId) scheduleSubtaskExtraction(knownParent);
        return;
    }
    // 列表刷新可能尚未写入关系缓存：先查当前摘要（同步、零请求）。
    const summaries = store.subtaskSummaries || [];
    for (const s of summaries) {
        if (s && s.childSessionId === sessionID) {
            subtaskParentByChild.set(sessionID, store.currentSessionId);
            scheduleSubtaskExtraction(store.currentSessionId);
            return;
        }
    }
    // 关系未知：只允许一个查询在途，避免高频 tool delta 触发查询风暴。
    if (subtaskParentResolving.has(sessionID)) return;
    subtaskParentResolving.add(sessionID);
    resolveOpenOwner(sessionID).then(function(owner) {
        if (owner && owner.ok && owner.ownerSessionID) {
            subtaskParentByChild.set(sessionID, owner.ownerSessionID);
            if (owner.ownerSessionID === store.currentSessionId) {
                scheduleSubtaskExtraction(owner.ownerSessionID);
            }
        }
    }).catch(function() {
        // 查询失败（会话已删等）不打断事件流；下一次面板刷新会重建已知关系。
    }).finally(function() {
        subtaskParentResolving.delete(sessionID);
    });
}

/** 渲染子任务面板
 *  内容指纹：列表结构/状态未变化时跳过整块重建，避免高频事件导致的 DOM 抖动；
 *  运行时长每秒由独立定时器更新文本，不参与指纹。 */
export function renderSubtaskPanel() {
    const box = document.getElementById('ocSubtasks');
    if (!box) return;
    if (!store.webRunning || !store.currentSessionId) {
        if (box.dataset.fp !== 'off') {
            box.innerHTML = '<div class="empty-state empty-state--sm">启动服务并选择会话后查看子任务</div>';
            box.dataset.fp = 'off';
        }
        return;
    }
    if (!store.subtaskSummaries.length) {
        if (box.dataset.fp !== 'empty') {
            box.innerHTML = '<div class="empty-state empty-state--sm">当前会话暂无子任务<br><small>子任务会在主会话触发 task 工具后显示在这里</small></div>';
            box.dataset.fp = 'empty';
        }
        return;
    }
    // 指纹只取影响外观/点击定位的稳定字段；durationMs 每秒变化，排除在外。
    // startedAt 纳入指纹：首次缺失、后续补全时需要重建一次，秒表才会启动。
    const fp = store.subtaskSummaries.map(function(s) {
        return [s.childSessionId, s.title, s.agent, s.model, s.status,
            s.interrupted ? '1' : '0', s.parentMessageId, s.startedAt || 0].join('\u0001');
    }).join('\u0002');
    if (box.dataset.fp === fp) return;
    let html = '';
    store.subtaskSummaries.forEach((s, idx) => {
        html += renderSubtaskCard(s, idx);
    });
    // 先成功拼出 HTML 再写指纹，避免渲染异常留下「有指纹、无内容」的空面板
    box.dataset.fp = fp;
    box.innerHTML = html;
    attachSubtaskCardEvents();
}

/** 渲染单张子任务卡片（两行结构）：
 *  第一行：任务标题 + 「详情」文字链接 + 右对齐耗时
 *  第二行：agent · model + 右侧状态徽标 */
export function renderSubtaskCard(s, idx) {
    const statusClass = 'status-' + (s.status || 'pending');
    const statusLabels = { completed: '已完成', running: '运行中', error: '失败', interrupt: '已中断', pending: '等待中', ended: '已结束' };
    const statusLabel = statusLabels[s.status] || s.status || '未知';
    // 运行中的卡片写入开始时间，由每秒定时器只更新文本，实现实时走秒
    const startedAt = (s.status === 'running' && Number(s.startedAt)) ? Number(s.startedAt) : 0;
    const durationText = startedAt
        ? formatSubtaskDuration(Math.max(0, Date.now() - startedAt))
        : (s.durationMs != null ? formatSubtaskDuration(s.durationMs) : (s.status === 'running' ? '运行中…' : '—'));
    // agent / model 任一可能缺失，避免渲染出孤立的「·」
    const metaText = [s.agent, s.model].filter(Boolean).join(' · ') || '—';

    return '<div class="oc-subtask-card ' + statusClass + '" data-index="' + idx + '" data-parent-message-id="' + escapeHtml(s.parentMessageId) + '" data-child-session-id="' + escapeHtml(s.childSessionId || '') + '">'
        + '<div class="oc-subtask-card-row oc-subtask-card-row-main">'
        + '<span class="oc-subtask-card-title" title="' + escapeHtml(s.title) + '">' + escapeHtml(s.title) + '</span>'
        + '<oc-button variant="bare" size="xs" class="oc-subtask-detail-btn" data-index="' + idx + '" ' + (s.childSessionId ? '' : 'disabled') + '>详情</oc-button>'
        + '<span class="oc-subtask-card-duration"' + (startedAt ? ' data-started-at="' + startedAt + '"' : '') + '>' + durationText + '</span>'
        + '</div>'
        + '<div class="oc-subtask-card-row oc-subtask-card-row-sub">'
        + '<span class="oc-subtask-card-meta" title="' + escapeHtml(metaText) + '">' + escapeHtml(metaText) + '</span>'
        + '<span class="oc-subtask-status-badge status-' + escapeHtml(s.status || 'pending') + '">' + statusLabel + '</span>'
        // 运行中的子任务：悬浮时「运行中」徽标换成「停止」按钮（同一位置切换）
        + (s.status === 'running'
            ? '<oc-button variant="ghost" size="xs" class="oc-subtask-stop-btn" data-child-session-id="' + escapeHtml(s.childSessionId || '') + '" title="停止子任务">停止</oc-button>'
            : '')
        + '</div>'
        + '</div>';
}

/** 子任务运行时长秒表：只改 textContent，不重建 DOM。 */
let subtaskDurationTimer = 0;
function startSubtaskDurationTicker() {
    if (subtaskDurationTimer) return;
    subtaskDurationTimer = setInterval(function() {
        const nodes = document.querySelectorAll('.oc-subtask-card-duration[data-started-at]');
        if (!nodes.length) return;
        const now = Date.now();
        nodes.forEach(function(el) {
            const start = Number(el.getAttribute('data-started-at'));
            if (!start) return;
            el.textContent = formatSubtaskDuration(Math.max(0, now - start));
        });
    }, 1000);
}
startSubtaskDurationTicker();

/** 绑定子任务卡片事件 */
export function attachSubtaskCardEvents() {
    const box = document.getElementById('ocSubtasks');
    if (!box) return;
    box.removeEventListener('click', onSubtaskCardClick);
    box.addEventListener('click', onSubtaskCardClick);
}

/** 子任务工具名（消息缓存反查用）：v1 为 task，v2 为 subagent。 */
const SUBTASK_TOOL_NAMES = ['subagent', 'task'];

/** 判断单个 part 是否为指定子会话的 subagent/task 工具调用（纯函数，便于单测）。
 *  metadata 兼容两种形态：state.metadata（历史适配层）、part.metadata（部分实时事件）。 */
export function matchSubtaskPart(part, childId) {
    if (!part || part.type !== 'tool') return false;
    const toolName = part.tool || part.name || '';
    if (!SUBTASK_TOOL_NAMES.includes(toolName)) return false;
    if (!childId) return false;
    const meta = (part.state && part.state.metadata) || part.metadata || {};
    return !!meta && meta.sessionID === childId;
}

/** 在当前会话已加载的消息缓存中反查 childSessionId 对应的子任务工具 part。
 *  从后往前扫（最新的调用优先命中）。命中返回 { parentMessageId, taskPartId }；
 *  缓存中不存在（消息未加载）返回 null——调用方不得触发历史加载，改走弹窗兜底。 */
export function findCachedSubtaskPart(childSessionId) {
    if (!childSessionId) return null;
    const items = getCachedMessages(store.currentSessionId);
    for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i] || {};
        const info = item.info || item;
        const parts = Array.isArray(item.parts) ? item.parts : [];
        for (let j = parts.length - 1; j >= 0; j--) {
            if (!matchSubtaskPart(parts[j], childSessionId)) continue;
            return {
                parentMessageId: info.id || '',
                taskPartId: parts[j].id || '',
            };
        }
    }
    return null;
}

/** 当前打开详情弹窗的子任务提示词（列表接口不含此项，从父任务 part 反查后缓存于此） */
let currentSubtaskPrompt = '';

/** 取子任务在父会话缓存中的 subagent/task 工具 part（与 findCachedSubtaskPart 同源，返回 part 本体） */
export function findCachedSubtaskTaskPart(childSessionId) {
    if (!childSessionId) return null;
    const items = getCachedMessages(store.currentSessionId);
    for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i] || {};
        const parts = Array.isArray(item.parts) ? item.parts : [];
        for (let j = parts.length - 1; j >= 0; j--) {
            if (matchSubtaskPart(parts[j], childSessionId)) return parts[j];
        }
    }
    return null;
}

/** 从 subagent/task part 的输入里提取发给子 agent 的提示词（prompt 优先，description 兜底） */
export function extractSubtaskPrompt(part) {
    const input = part && part.state && part.state.input;
    if (!input) return '';
    if (typeof input.prompt === 'string' && input.prompt.trim()) return input.prompt.trim();
    if (typeof input.description === 'string' && input.description.trim()) return input.description.trim();
    return '';
}

/** 停止运行中的子任务（子会话）：中断后刷新子任务面板 */
async function stopSubtask(childSessionId) {
    if (!childSessionId) return;
    try {
        await api.OpenCodeCall('POST', `/api/session/${encodeURIComponent(childSessionId)}/interrupt`);
        showToast('已停止子任务', 'info');
        refreshSubtaskPanel();
    } catch (e) {
        showApiError('停止子任务失败: ', e);
    }
}

/** 子任务卡片点击处理 */
export function onSubtaskCardClick(e) {
    // 停止按钮：先拦截，避免顺带触发卡片的「定位 / 详情」
    const stopBtn = e.target.closest('.oc-subtask-stop-btn');
    if (stopBtn) {
        e.stopPropagation();
        e.preventDefault();
        stopSubtask(stopBtn.dataset.childSessionId);
        return;
    }
    const detailBtn = e.target.closest('.oc-subtask-detail-btn');
    if (detailBtn) {
        e.stopPropagation();
        const idx = parseInt(detailBtn.dataset.index);
        if (isNaN(idx) || !store.subtaskSummaries[idx]) return;
        const summary = store.subtaskSummaries[idx];
        if (summary.childSessionId) {
            openSubtaskModal(summary.childSessionId, summary);
        }
        return;
    }
    // 卡片本身点击 → 定位优先（仅缓存反查，不自动加载历史）：
    // 1) 在已加载的消息缓存里反查该子会话对应的 subagent/task tool part；
    // 2) 命中且 DOM 中存在对应父消息 → 滚动定位（locateParentMessage 返回 true）；
    // 3) 未命中（消息未加载进缓存 / 缓存有但 DOM 无）→ 打开子会话详情弹窗兜底。
    const card = e.target.closest('.oc-subtask-card');
    if (!card) return;
    const childId = card.dataset.childSessionId;
    if (!childId) return; // 无子会话 id（防御）：维持无操作
    const hit = findCachedSubtaskPart(childId);
    if (hit && locateParentMessage(hit.parentMessageId)) return;
    const summary = store.subtaskSummaries.find(s => s.childSessionId === childId) || null;
    openSubtaskModal(childId, summary);
}

/** 定位到父消息在消息列表中的位置。
 *  返回是否命中：主分支按 data-message-id 精确查询；fallback 分支按子任务摘要
 *  的 parentMessageId/taskPartId 匹配（兼容「消息卡片无父消息 id、但有 part id」的来源；
 *  列表数据源下 parentMessageId 为空串，该分支不命中，仅作历史兼容保留）。
 *  目标消息不在 DOM（未加载）时返回 false，由调用方决定兜底动作。 */
export function locateParentMessage(msgId) {
    const box = getActiveMessagesEl();
    if (!box) return false;
    const old = box.querySelectorAll('.oc-message.highlight');
    old.forEach(el => el.classList.remove('highlight'));
    let target = null;
    if (msgId) {
        target = box.querySelector('.oc-message[data-message-id="' + msgId + '"]');
    }
    if (!target && msgId) {
        const allMsgs = box.querySelectorAll('.oc-message');
        for (let i = allMsgs.length - 1; i >= 0; i--) {
            const partIds = allMsgs[i].querySelectorAll('[data-part-id]');
            for (const p of partIds) {
                if (store.subtaskSummaries.some(s => s.parentMessageId === msgId && s.taskPartId === p.dataset.partId)) {
                    target = allMsgs[i];
                    break;
                }
            }
            if (target) break;
        }
    }
    if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('highlight');
        setTimeout(() => target.classList.remove('highlight'), 2500);
        return true;
    }
    return false;
}

/** 打开子任务详情弹窗 */
export function openSubtaskModal(childSessionId, subtaskSummary) {
    const modal = document.getElementById('subtaskModal');
    if (!modal) return;

    // 发给子 agent 的提示词：列表接口不带此项，从父消息缓存的 subagent/task part 反查
    const taskPart = findCachedSubtaskTaskPart(childSessionId);
    currentSubtaskPrompt = (subtaskSummary && subtaskSummary.promptPreview) || extractSubtaskPrompt(taskPart);

    if (subtaskSummary) {
        // 让摘要里的「展开原始任务」也能显示反查到的提示词
        if (!subtaskSummary.promptPreview) subtaskSummary.promptPreview = currentSubtaskPrompt;
        fillModalSummary(subtaskSummary);
    }

    const msgBox = document.getElementById('subtaskMessages');
    if (msgBox) msgBox.innerHTML = '<div class="oc-loading" style="padding:40px;text-align:center"><div class="spinner"></div><p>正在加载子任务详情...</p></div>';

    modal.style.display = 'flex';
    loadSubtaskDetailMessages(childSessionId);
    bindSubtaskModalEvents();
}

/** 关闭子任务详情弹窗 */
export function closeSubtaskModal() {
    const modal = document.getElementById('subtaskModal');
    if (modal) modal.style.display = 'none';
    if (document.activeElement && document.activeElement.closest('#subtaskModal')) {
        const promptEl = document.getElementById('ocPrompt');
        if (promptEl) promptEl.focus();
    }
}

/** 绑定子任务详情弹窗事件 */
export function bindSubtaskModalEvents() {
    const modal = document.getElementById('subtaskModal');
    if (!modal || modal.dataset.eventsBound === '1') return;

    // 仅当按下与松开都在遮罩上才关闭（避免弹窗内拖选误关）
    bindOverlayClose(modal, closeSubtaskModal);
    document.getElementById('subtaskModalCloseBtn')?.addEventListener('click', closeSubtaskModal);

    const promptToggle = document.getElementById('subtaskPromptToggle');
    const promptText = document.getElementById('subtaskPromptText');
    if (promptToggle && promptText) {
        promptToggle.addEventListener('click', () => {
            const hidden = promptText.style.display === 'none';
            promptText.style.display = hidden ? '' : 'none';
            promptToggle.textContent = hidden ? '收起原始任务' : '展开原始任务';
        });
    }

    const copyBtn = document.getElementById('subtaskCopySid');
    copyBtn?.addEventListener('click', async () => {
        const sid = document.getElementById('subtaskSid')?.textContent || '';
        if (!sid) return;
        try {
            await copyToClipboard(sid);
            showToast('已复制: ' + sid, 'success');
        } catch (_) {
            showToast('复制失败', 'error');
        }
    });

    document.addEventListener('keydown', onSubtaskModalKey);
    modal.dataset.eventsBound = '1';
}

/** 子任务弹窗键盘事件（Esc 关闭） */
export function onSubtaskModalKey(e) {
    if (e.key !== 'Escape') return;
    const modal = document.getElementById('subtaskModal');
    if (modal && modal.style.display === 'flex') closeSubtaskModal();
}

/** 填充子任务弹窗摘要信息 */
export function fillModalSummary(s) {
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val || '—'; };
    const setHtml = (id, val) => { const el = document.getElementById(id); if (el) el.innerHTML = val || '—'; };

    // 标题只在弹窗头部显示一次（原摘要区重复的标题行已移除）
    document.getElementById('subtaskModalTitle').textContent = s.title || '子任务详情';
    setHtml('subtaskAgent', escapeHtml(s.agent || '—'));
    setHtml('subtaskModel', escapeHtml(s.model || '—'));

    const duration = s.durationMs != null ? formatSubtaskDuration(s.durationMs) : (s.status === 'running' ? '运行中…' : '—');
    set('subtaskDuration', duration);
    set('subtaskStarted', formatMinuteTime(s.startedAt));
    set('subtaskEnded', formatMinuteTime(s.endedAt));

    const desc = s.description || '';
    const descRow = document.getElementById('subtaskDescRow');
    if (descRow) descRow.style.display = desc ? '' : 'none';
    set('subtaskDesc', desc);

    const prompt = s.promptPreview || '';
    const promptCollapse = document.querySelector('.subtask-prompt-collapse');
    if (promptCollapse) promptCollapse.style.display = prompt ? '' : 'none';
    set('subtaskPromptText', prompt);

    set('subtaskSid', s.childSessionId || '');

    const statusLabels = { completed: '已完成', running: '运行中', error: '失败', interrupt: '已中断', pending: '等待中', ended: '已结束' };
    const statusLabel = statusLabels[s.status] || s.status || '未知';
    const updateBadge = (el, text, st) => {
        if (!el) return;
        el.textContent = text;
        el.dataset.status = st;
    };
    updateBadge(document.getElementById('subtaskStatusBadge'), statusLabel, s.status);
}

/** 加载子任务详情消息 */
export async function loadSubtaskDetailMessages(childSessionId) {
    if (!childSessionId) return;
    if (store.detailLoading[childSessionId]) return;
    store.detailLoading[childSessionId] = true;
    const msgBox = document.getElementById('subtaskMessages');
    const thisSeq = ++store.detailMessageLoadSeq;

    try {
        // 全量读取：按 cursor.next 逐页翻到空页/无续翻游标，避免只显示服务端默认的一页。
        // 每页请求后检查 seq，切走子任务立即中止。
        let items = [];
        let cursor = '';
        for (let page = 0; page < SUBTASK_MESSAGE_MAX_PAGES; page++) {
            let path = '/api/session/' + encodeURIComponent(childSessionId) + '/message?limit=' + SUBTASK_MESSAGE_PAGE;
            if (cursor) path += '&cursor=' + encodeURIComponent(cursor);
            const res = await api.OpenCodeCall('GET', path);
            if (thisSeq !== store.detailMessageLoadSeq) return;

            // v2 返回 {data:[扁平消息], cursor}，需还原为 v1 的 [{info,parts}] 且按旧→新排列
            const pageItems = adaptMessages(childSessionId, res);
            const rawCount = Array.isArray(res && res.data) ? res.data.length : pageItems.length;
            if (!pageItems.length) break;
            // 后续页是更早的消息：拼到前面，保持整体旧→新
            items = pageItems.concat(items);
            cursor = nextCursor(res) || '';
            // 到顶判定看原始页条数（解析层会过滤 idle 等边界消息）
            if (!cursor || rawCount < SUBTASK_MESSAGE_PAGE) break;
        }
        // 子会话消息通常只有助手回复：用父任务 part 反查到的提示词补一条「子任务输入」，
        // 保证详情内容区能看到发给子 agent 的原始提示词
        if (currentSubtaskPrompt && !items.some(it => (it.info || it).role === 'user')) {
            items.unshift({ info: { role: 'user' }, parts: [{ type: 'text', text: currentSubtaskPrompt }] });
        }
        if (!items.length) {
            if (msgBox) msgBox.innerHTML = '<div class="empty-state empty-state--sm">子会话暂无消息</div>';
            return;
        }
        if (thisSeq !== store.detailMessageLoadSeq) return;
        renderDetailMessages(items, childSessionId);
    } catch (err) {
        if (thisSeq !== store.detailMessageLoadSeq) return;
        if (msgBox) msgBox.innerHTML = '<div class="empty-state empty-state--sm empty-state--error">加载失败：' + escapeHtml(formatApiError(err) || '网络错误') + '</div>';
    } finally {
        store.detailLoading[childSessionId] = false;
    }
}

/** 渲染子任务详情消息列表：与会话区共用同一套消息卡片（外观与交互自动保持一致） */
export function renderDetailMessages(items, sessionID) {
    const box = document.getElementById('subtaskMessages');
    if (!box) return;
    box.innerHTML = '';
    (items || []).forEach(item => {
        box.appendChild(buildMessageNode(item, sessionID));
    });
}
