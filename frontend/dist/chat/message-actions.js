// ============================================================
// chat/message-actions.js — 消息卡片内部最底部的操作行
// 用户消息：复制 / 引用 / 分叉
// 助手最终正文：复制 / 引用 / 收藏到知识库
// ============================================================

import { store } from '../core/state.js';
import { getCachedMessages, copyToClipboard, showToast } from '../core/utils.js';
import { selectSession } from './session.js';
import { messageActionText } from './render.js';
// 分叉逻辑与命令面板 /fork 共用一份实现，避免两处各写一遍请求与响应解析
import { forkSessionAt } from './cmd-palette.js';
import { openKbEntryModal } from '../views/knowledge.js';

/** 在指定会话的消息缓存里按 id 找消息条目。 */
function findMessage(sessionId, messageId) {
    if (!sessionId || !messageId) return null;
    const list = getCachedMessages(sessionId) || [];
    for (let i = 0; i < list.length; i++) {
        const info = list[i].info || list[i];
        if (String(info.id || '') === String(messageId)) return list[i];
    }
    return null;
}

/** 把文本引用到输入框：已有内容时追加（空一行），光标移到末尾并聚焦。 */
function quoteToPrompt(text) {
    const ta = document.getElementById('ocPrompt');
    if (!ta) return false;
    const cur = ta.value || '';
    const next = cur.trim() ? (cur.replace(/\s+$/, '') + '\n\n' + text) : text;
    ta.value = next;
    // 触发 input 让输入框组件/字数统计等同步
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
    ta.selectionStart = ta.selectionEnd = next.length;
    return true;
}

/** 收藏标题：取正文第一行，去掉常见 Markdown 标记后截断 30 字。
 *  只做行内清理，不引入 Markdown 解析器：
 *  标题井号、引用、列表符号、链接、图片、行内代码、加粗/斜体、删除线。 */
function collectTitle(text) {
    const first = (text.split('\n').find(function (line) { return line.trim(); }) || '').trim();
    const cleaned = first
        .replace(/^#{1,6}\s+/, '')                        // 标题
        .replace(/^>\s*/, '')                            // 引用
        .replace(/^[-*+]\s+/, '')                        // 无序列表
        .replace(/^\d+[.)]\s+/, '')                      // 有序列表
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')      // 图片 → alt
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')       // 链接 → 文本
        .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')          // 行内代码
        .replace(/\*\*(.+?)\*\*/g, '$1')                // 加粗
        .replace(/\*(.+?)\*/g, '$1')                     // 斜体（仅 *，避免误伤 snake_case）
        .replace(/~~(.+?)~~/g, '$1')                      // 删除线
        .replace(/\s+/g, ' ')                            // 折叠空白
        .trim();
    // 清理后为空（例如首行只有一张图片）就留空，交给用户在弹窗里填
    const title = cleaned;
    return title.length > 30 ? title.slice(0, 30) + '…' : title;
}

/** 点击操作按钮：所有动作都从当前会话缓存里取原文，避免把大段文本塞进 DOM 属性。 */
export async function handleMessageActionClick(event) {
    const btn = event.target.closest('.oc-msg-action');
    if (!btn) return;
    const row = btn.closest('.oc-msg-actions');
    if (!row) return;
    event.preventDefault();
    event.stopPropagation();
    if (btn.disabled) return;

    const act = btn.dataset.act || '';
    const messageId = row.dataset.messageId || '';
    const sessionId = row.dataset.sessionId || store.currentSessionId || '';
    const item = findMessage(sessionId, messageId);
    const text = item ? messageActionText(item) : '';

    if (act === 'copy') {
        if (!text) { showToast('没有可复制的文本', 'error'); return; }
        await copyToClipboard(text);
        showToast('已复制', 'success');
        return;
    }

    if (act === 'quote') {
        if (!text) { showToast('没有可引用的文本', 'error'); return; }
        if (quoteToPrompt(text)) showToast('已引用到输入框', 'success');
        return;
    }

    if (act === 'collect') {
        if (!text) { showToast('没有可收藏的文本', 'error'); return; }
        // 复用知识库条目弹窗：预填标题与内容，说明/分类/标签由用户补充
        await openKbEntryModal(null, { title: collectTitle(text), content: text });
        return;
    }

    if (act === 'fork') {
        if (!messageId) { showToast('找不到这条消息', 'error'); return; }
        btn.disabled = true;
        try {
            // 与命令面板 /fork 共用 forkSessionAt：请求、响应解析、打开 tab、刷新树都在那里
            const newId = await forkSessionAt(sessionId, messageId);
            if (newId) await selectSession(newId);
        } finally {
            btn.disabled = false;
        }
    }
}

/** 绑定消息池上的点击委托（幂等）。 */
export function bindMessageActions() {
    const pool = document.getElementById('ocMessagesPool');
    if (!pool || pool.dataset.msgActionsBound === 'true') return;
    pool.dataset.msgActionsBound = 'true';
    pool.addEventListener('click', handleMessageActionClick);
}
