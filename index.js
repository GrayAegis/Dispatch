/**
 * Dispatch: when in-fiction time passes, the world produces things the character could come
 * across (a paper on a stall, a text, a note under the door). They wait in an in-tray; the
 * narrator is told only that they are there; you read them if you want, and bring one into the
 * scene only when you choose. Artefacts are the same documents made to order from a menu.
 */
import { eventSource, event_types, extension_prompt_types, extension_prompt_roles, saveSettings as saveSettingsNow } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { oai_settings, getChatCompletionModel } from '../../../openai.js';
import { Popup, POPUP_TYPE } from '../../../popup.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { elapsed, timeLine } from './time.js';
import { KINDS, KIND_KEYS, parseDocuments, plainText, render, summary, systemPrompt, userPrompt } from './documents.js';

const MODULE_NAME = 'dispatch';
const LOG = '[Dispatch]';
const NOTE_KEY = 'DISPATCH_WORLD_NOTE';
const READ_KEY = 'DISPATCH_READ_NOTE';
const STATE_BLOCKS = /<!--[\s\S]*?-->/g;

const defaultSettings = {
    enabled: true,
    /** Make dispatches on their own when time passes. Off: only the button does. */
    auto: true,
    /** Hours of in-fiction time that count as "time passed". */
    thresholdHours: 3,
    /** Documents per dispatch. */
    count: 1,
    /** Recent messages the writer sees. */
    recent: 12,
    /** Where the writer runs: 'main' (the chat's connection, prompt sent straight), 'profile', or 'custom'. */
    source: 'main',
    /** Connection profile id, for source 'profile'. */
    profile: '',
    /** OpenAI-compatible endpoint, for source 'custom': base URL ending in /v1, model name, optional key. */
    customUrl: '',
    customModel: '',
    customKey: '',
    /** Extra request body for the custom endpoint, YAML, merged into the request (e.g. thinking: {type: disabled}). */
    customBody: '',
    /** Temperature for the writer; blank leaves it to the endpoint's default. */
    temperature: '',
    /** Console logging: 'normal' (events and errors), 'verbose' (also the full request and the raw answer). */
    logging: 'normal',
    /** Max tokens for the writer's answer. Thinking models spend some of this on reasoning first. */
    maxTokens: 4000,
    /** Depth of the one-turn world note. */
    depth: 0,
};

/** The one settings object, kept in place so every reference to it stays live. Missing keys get defaults. */
function settings() {
    if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
        extension_settings[MODULE_NAME] = {};
    }

    const s = extension_settings[MODULE_NAME];

    for (const [key, value] of Object.entries(defaultSettings)) {
        if (!(key in s)) {
            s[key] = value;
        }
    }

    return s;
}

function saveSettings() {
    getContext().saveSettingsDebounced();
}

/** Extra detail in the console when logging is set to verbose. Secrets are never printed. */
function verbose(label, value) {
    if (settings().logging === 'verbose') {
        console.info(LOG, label, value);
    }
}

/** Toasts, also written to the console so they can be read after they fade. */
const notify = {
    info: (text, options) => { console.info(LOG, text); return toastr.info(text, 'Dispatch', options); },
    success: (text, options) => { console.info(LOG, text); return toastr.success(text, 'Dispatch', options); },
    warning: (text, options) => { console.warn(LOG, text); return toastr.warning(text, 'Dispatch', options); },
    error: (text, options) => { console.error(LOG, text); return toastr.error(text, 'Dispatch', options); },
};

/** Per-chat store, in chat metadata. */
function store() {
    const context = getContext();
    const meta = context.chatMetadata;

    if (!meta) {
        return null;
    }

    meta[MODULE_NAME] ??= { items: [], lastTime: null, lastCheckedId: -1, noteFor: [], readFor: null };
    return meta[MODULE_NAME];
}

function saveStore() {
    getContext().saveMetadataDebounced();
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ---------------------------------------------------------------- the writer */

/** Exposed so tests and other extensions can swap the model call. Returns the answer text. */
export const writer = {
    async call(messages, maxTokens) {
        const context = getContext();
        const s = settings();
        const service = context.ChatCompletionService;
        const temperature = s.temperature === '' || s.temperature === null ? undefined : Number(s.temperature);
        verbose('writer request', {
            route: s.source,
            model: s.source === 'custom' ? s.customModel : s.source === 'profile' ? profileName(s.profile) : getChatCompletionModel(),
            endpoint: s.source === 'custom' ? s.customUrl : s.source === 'profile' ? '(profile)' : oai_settings.chat_completion_source,
            maxTokens,
            temperature,
            extraBody: s.source === 'custom' ? (s.customBody || null) : null,
            messages,
        });
        const unwrap = (result) => {
            if (typeof result === 'string') {
                return result;
            }

            const content = String(result?.content ?? '').trim();
            const reasoning = String(result?.reasoning ?? '').trim();
            writer.lastReasoning = reasoning;
            verbose('writer answer', { contentChars: content.length, reasoningChars: reasoning.length, content, reasoning });

            if (!content) {
                console.warn(LOG, reasoning ? `the writer answered with ${reasoning.length} chars of reasoning but no content` : 'the writer answered with nothing', result);
            }

            return content;
        };
        writer.lastReasoning = '';

        if (s.source === 'custom') {
            if (!s.customUrl || !s.customModel) {
                throw new Error('custom endpoint needs a URL and a model name (Dispatch settings)');
            }

            const result = await service.processRequest({
                messages,
                model: s.customModel,
                chat_completion_source: 'custom',
                custom_url: s.customUrl.replace(/\/+$/, ''),
                custom_include_headers: s.customKey ? `Authorization: Bearer ${s.customKey}` : undefined,
                custom_include_body: s.customBody || undefined,
                max_tokens: maxTokens,
                temperature,
            }, {}, true);
            return unwrap(result);
        }

        if (s.source === 'profile' && s.profile && context.ConnectionManagerRequestService) {
            const manager = context.ConnectionManagerRequestService;

            try {
                return unwrap(await manager.sendRequest(s.profile, messages, maxTokens, { includePreset: false, includeInstruct: false }));
            } catch (plain) {
                console.warn(LOG, 'profile request without its preset failed, retrying with it:', plain);

                try {
                    return unwrap(await manager.sendRequest(s.profile, messages, maxTokens));
                } catch (withPreset) {
                    throw new Error(`profile "${profileName(s.profile)}": ${plain?.message ?? plain}; with its preset: ${withPreset?.message ?? withPreset}`);
                }
            }
        }

        // Main: the chat's connection, the prompt sent straight. No preset prompts, no samplers, no
        // reasoning settings: just messages, model, endpoint, max tokens.
        if (context.mainApi === 'openai' && service) {
            try {
                const live = oai_settings;
                const result = await service.processRequest({
                    messages,
                    model: getChatCompletionModel(),
                    chat_completion_source: live.chat_completion_source,
                    max_tokens: maxTokens,
                    temperature,
                    include_reasoning: false,
                    custom_url: live.custom_url,
                    custom_include_headers: live.custom_include_headers,
                    custom_include_body: live.custom_include_body,
                    custom_exclude_body: live.custom_exclude_body,
                    custom_prompt_post_processing: live.custom_prompt_post_processing,
                    reverse_proxy: live.reverse_proxy,
                    proxy_password: live.proxy_password,
                    zai_endpoint: live.zai_endpoint,
                    siliconflow_endpoint: live.siliconflow_endpoint,
                    minimax_endpoint: live.minimax_endpoint,
                    pollinations_endpoint: live.pollinations_endpoint,
                    vertexai_region: live.vertexai_region,
                }, {}, true);
                return unwrap(result);
            } catch (error) {
                console.warn(LOG, 'straight request on the chat connection failed; using raw generation (preset parameters apply):', error);
            }
        }

        const system = messages.find(m => m.role === 'system')?.content ?? '';
        const rest = messages.filter(m => m.role !== 'system');
        const raw = await context.generateRaw({ prompt: rest, systemPrompt: system, responseLength: maxTokens });
        verbose('writer answer (raw generation)', raw);
        return raw;
    },
};

function profileName(id) {
    const profiles = getContext().extensionSettings?.connectionManager?.profiles ?? [];
    return profiles.find(p => p.id === id)?.name ?? id;
}

function cleanText(text) {
    return String(text ?? '').replace(STATE_BLOCKS, '').replace(/\n{3,}/g, '\n\n').trim();
}

async function referenceText() {
    const context = getContext();
    const parts = [];

    try {
        const fields = context.getCharacterCardFields?.() ?? {};

        for (const key of ['description', 'personality', 'scenario']) {
            if (fields[key]) {
                parts.push(`<${key}>\n${cleanText(fields[key])}\n</${key}>`);
            }
        }
    } catch (error) {
        console.debug(LOG, 'no card fields', error);
    }

    try {
        const persona = context.powerUserSettings?.persona_description;

        if (persona) {
            parts.push(`<persona of ${context.name1}>\n${cleanText(persona)}\n</persona>`);
        }
    } catch (error) {
        console.debug(LOG, 'no persona', error);
    }

    try {
        const chat = (context.chat ?? []).filter(m => !m.is_system).map(m => `${m.name}: ${cleanText(m.mes)}`).reverse();
        const wi = await context.getWorldInfoPrompt(chat, 32000, true);
        const text = [wi?.worldInfoBefore, wi?.worldInfoAfter].filter(Boolean).join('\n\n').trim();

        if (text) {
            parts.push(`<world_info>\n${text}\n</world_info>`);
        }
    } catch (error) {
        console.debug(LOG, 'no world info', error);
    }

    return parts.join('\n\n');
}

function storyText(recent) {
    const context = getContext();
    const chat = (context.chat ?? []).filter(m => !m.is_system);
    return chat.slice(-recent).map(m => `${m.name}: ${cleanText(m.mes)}`).join('\n\n');
}

function currentPlace() {
    const context = getContext();

    for (let i = (context.chat?.length ?? 0) - 1; i >= 0; i--) {
        const m = context.chat[i];

        if (m?.is_user || m?.is_system) {
            continue;
        }

        const block = /<!--\s*state\b([\s\S]*?)-->/i.exec(m?.mes ?? '');
        const line = block?.[1].split(/\r?\n/).map(l => l.trim()).find(l => /^time\s*:/i.test(l) || /^place\s*:/i.test(l));
        const place = line && (/place\s*:\s*(.+)$/i.exec(line)?.[1] ?? null);

        if (place) {
            return place.trim();
        }
    }

    return null;
}

async function produce({ mode, request, n }) {
    const context = getContext();
    const s = settings();
    const messages = [
        { role: 'system', content: systemPrompt({ mode, n, userName: context.name1 }) },
        { role: 'user', content: userPrompt({ reference: await referenceText(), story: storyText(s.recent), request }) },
    ];
    let answer = await writer.call(messages, s.maxTokens);
    let docs = parseDocuments(answer);
    verbose('parsed documents', docs);

    if (!docs.length && !String(answer ?? '').trim()) {
        // No content: most often a thinking model that spent the whole budget reasoning. Once more, with room.
        console.warn(LOG, `no content at ${s.maxTokens} tokens; retrying with ${s.maxTokens * 2}`);
        answer = await writer.call(messages, s.maxTokens * 2);
        docs = parseDocuments(answer);
    }

    if (!docs.length && !String(answer ?? '').trim() && writer.lastReasoning) {
        // Still nothing: some models put the answer inside their reasoning. Last try.
        console.warn(LOG, 'still no content; looking for documents in the reasoning text');
        answer = writer.lastReasoning;
        docs = parseDocuments(answer);
    }

    if (!docs.length) {
        const text = String(answer ?? '');
        console.warn(LOG, `the writer returned nothing usable (${text.length} chars). Start:`, text.slice(0, 400) || '<empty string>', '… End:', text.slice(-300));

        if (text.trim()) {
            notify.warning(`The writer answered (${text.length} characters) but it couldn't be read as documents. If the answer looks cut off, raise Max tokens in Dispatch settings (now ${s.maxTokens}).`, { timeOut: 10000 });
        }
    }

    return docs;
}

/* ---------------------------------------------------------------- dispatches */

let busy = false;
let workingToast = null;

/** A toast that stays up while the writer works, so a failure is recognisably Dispatch's and not the chat's. */
function working(text) {
    stopWorking();
    console.info(LOG, text);
    workingToast = toastr.info(text, 'Dispatch is writing', { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false, progressBar: false });
}

function stopWorking() {
    if (workingToast) {
        toastr.clear(workingToast);
        workingToast = null;
    }
}

function failed(error) {
    const message = String(error?.message ?? error ?? 'unknown error');
    console.error(LOG, 'writer failed:', error);
    notify.error(`The writer's request failed: ${message}. The chat itself is unaffected.`, { timeOut: 8000 });
}

async function dispatch(hours, { manual = false } = {}) {
    const s = settings();
    const data = store();

    if (!data) {
        return [];
    }

    if (busy) {
        notify.info('Still writing the last one.');
        return [];
    }

    busy = true;
    setStatus('writing…');
    const span = hours >= 48 ? `${Math.round(hours / 24)} days` : hours >= 1 ? `${Math.round(hours)} hours` : 'a short while';
    working(`About ${span} passed. Writing what the world produced…`);

    try {
        const place = currentPlace();
        const request = `Time that just passed: about ${span}.${place ? ` ${getContext().name1} is now at: ${place}.` : ''} Produce the documents that came into existence in that time and could be encountered here.`;
        const docs = await produce({ mode: 'dispatch', request, n: Math.max(1, Math.min(4, Number(s.count) || 1)) });
        const index = (getContext().chat?.length ?? 1) - 1;

        for (const doc of docs) {
            data.items.unshift({ id: uid(), origin: manual ? 'manual' : 'dispatch', status: 'unread', mentioned: false, at: index, hours, ...doc });
        }

        if (docs.length) {
            data.noteFor = data.items.slice(0, docs.length).map(d => d.id);
            applyWorldNote();
            saveStore();
            notify.info(`${docs.length} new ${docs.length === 1 ? 'thing' : 'things'} in the world.`);
        } else if (manual) {
            notify.warning('Nothing came back from the writer. See the console.');
        }

        refreshBadge();
        return docs;
    } catch (error) {
        failed(error);
        return [];
    } finally {
        stopWorking();
        busy = false;
        setStatus('');
    }
}

/** Tell the narrator, for one generation, what is within reach and where. */
function applyWorldNote() {
    const context = getContext();
    const s = settings();
    const data = store();
    const pending = (data?.items ?? []).filter(item => data.noteFor?.includes(item.id) && !item.mentioned);

    if (!s.enabled || !pending.length) {
        context.setExtensionPrompt(NOTE_KEY, '', extension_prompt_types.IN_CHAT, Number(s.depth) || 0);
        return;
    }

    const lines = pending.map(item => `- ${item.found || KINDS[item.kind]?.found}: ${summary(item)}.`);
    const note = `[World: since time passed, the following now exist and are within ${context.name1}'s reach in this scene. Let each be present and noticeable in a sentence of ordinary detail (a stall, a screen, a phone lighting up, an envelope), in the scene's own texture. Do not read it out, summarise it, or have anyone recite it; ${context.name1} decides whether to look, and only ${context.name1} does.\n${lines.join('\n')}]`;
    context.setExtensionPrompt(NOTE_KEY, note, extension_prompt_types.IN_CHAT, Number(s.depth) || 0, false, extension_prompt_roles.SYSTEM);
}

/** Give the narrator the document's contents, for one generation. */
function applyReadNote() {
    const context = getContext();
    const s = settings();
    const data = store();
    const item = data?.items.find(i => i.id === data.readFor);

    if (!s.enabled || !item) {
        context.setExtensionPrompt(READ_KEY, '', extension_prompt_types.IN_CHAT, 0);
        return;
    }

    const note = `[${context.name1} has just read the following, which is now known to them exactly as written. Continue from their having read it: the people around them react only to what they can see of ${context.name1} reading, not to the contents, unless they already know them. Do not reproduce the document; do not decide what ${context.name1} makes of it or what they do next.\n\n${plainText(item)}]`;
    context.setExtensionPrompt(READ_KEY, note, extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
}

function bringIn(item) {
    const data = store();

    if (!data) {
        return;
    }

    data.readFor = item.id;
    item.status = 'read';
    item.brought = true;
    applyReadNote();
    saveStore();
    refreshBadge();
    notify.success('The narrator will know it was read on your next turn.');
}

/** After a reply arrives: settle the one-turn notes, then see whether time passed. */
async function onReply(messageId) {
    const context = getContext();
    const s = settings();
    const data = store();
    const message = context.chat?.[messageId];

    if (!data || !message || message.is_user || message.is_system) {
        return;
    }

    // Notes shown to the narrator this turn are spent.
    for (const id of data.noteFor ?? []) {
        const item = data.items.find(i => i.id === id);

        if (item) {
            item.mentioned = true;
        }
    }

    data.noteFor = [];
    data.readFor = null;
    applyWorldNote();
    applyReadNote();

    const currentTime = timeLine(message.mes);
    const previousTime = data.lastTime;
    let userText = '';

    // Only what the user wrote since the previous reply counts; a swipe or continue has nothing new.
    for (let i = messageId - 1; i >= 0; i--) {
        const m = context.chat[i];

        if (!m || m.is_system) {
            continue;
        }

        if (!m.is_user) {
            break;
        }

        userText = `${m.mes}\n${userText}`;
    }

    const hours = elapsed({ previousTime, currentTime, userText });

    if (currentTime) {
        data.lastTime = currentTime;
    }

    const already = data.lastCheckedId === messageId;
    data.lastCheckedId = messageId;
    saveStore();

    if (s.enabled && s.auto && !already && hours >= Number(s.thresholdHours)) {
        console.debug(LOG, `about ${hours}h passed; dispatching`);
        await dispatch(hours);
    }
}

/* ---------------------------------------------------------------- artefacts */

async function artefact({ kind, author, subject, notes }) {
    const data = store();

    if (!data) {
        return null;
    }

    if (busy) {
        notify.info('Still writing the last one.');
        return null;
    }

    busy = true;
    setStatus('writing…');
    working(`Writing a ${KINDS[kind]?.label.toLowerCase() ?? kind}…`);

    try {
        const request = [
            `Request: one ${KINDS[kind]?.label.toLowerCase() ?? kind} (kind: ${kind}).`,
            author ? `Author or source: ${author}.` : null,
            subject ? `Subject: ${subject}.` : null,
            notes ? `Notes: ${notes}` : null,
        ].filter(Boolean).join(' ');
        const docs = await produce({ mode: 'artefact', request, n: 1 });
        const doc = docs[0];

        if (!doc) {
            notify.warning('Nothing came back from the writer. See the console.');
            return null;
        }

        doc.kind = KIND_KEYS.includes(kind) ? kind : doc.kind;
        const item = { id: uid(), origin: 'artefact', status: 'read', mentioned: true, at: (getContext().chat?.length ?? 1) - 1, ...doc };
        data.items.unshift(item);
        saveStore();
        refreshBadge();
        return item;
    } catch (error) {
        failed(error);
        return null;
    } finally {
        stopWorking();
        busy = false;
        setStatus('');
    }
}

/* ---------------------------------------------------------------- lorebook filing */

async function fileToLorebook(item) {
    const context = getContext();

    try {
        const book = (await context.executeSlashCommandsWithOptions('/getchatbook'))?.pipe?.trim();

        if (!book) {
            throw new Error('no chat lorebook');
        }

        const keys = [item.title, item.source, item.from].filter(Boolean).map(k => k.replace(/[,"]/g, ' ').trim()).filter(Boolean).slice(0, 4);
        const content = plainText(item).replace(/"/g, '\'');
        const quote = (s) => `"${String(s).replace(/"/g, '\'')}"`;
        const result = await context.executeSlashCommandsWithOptions(`/createentry file=${quote(book)} key=${quote(keys.join(', '))} ${quote(content)}`);
        item.filed = { book, uid: result?.pipe ?? null };
        saveStore();
        notify.success(`Filed in "${book}".`);
    } catch (error) {
        console.error(LOG, error);
        notify.error('Could not file it: ' + String(error?.message ?? error));
    }
}

/* ---------------------------------------------------------------- export */

let cssText = null;

/** The document styles, for standalone files. Only the page rules, not the tray. */
async function documentCss() {
    if (cssText !== null) {
        return cssText;
    }

    try {
        const url = new URL('./style.css', import.meta.url);
        const text = await (await fetch(url)).text();
        const start = text.indexOf('/* ---- documents');
        cssText = start >= 0 ? text.slice(start) : text;
    } catch (error) {
        console.warn(LOG, 'could not load style.css for export', error);
        cssText = '';
    }

    return cssText;
}

function safeName(item) {
    const base = `${KINDS[item.kind]?.label ?? item.kind} - ${item.title || item.source}`;
    return base.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'document';
}

async function standaloneHtml(item) {
    const css = await documentCss();
    const page = render(item, getContext().name1);
    const title = (item.title || item.source || 'Document').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
html, body { margin: 0; padding: 0; background: #2b2b2b; }
body { display: flex; justify-content: center; padding: 40px 16px; box-sizing: border-box; min-height: 100vh; }
${css}
</style>
</head>
<body>
${page.outerHTML}
</body>
</html>`;
}

/** Draw a rendered page to a PNG via an SVG foreignObject; works because the page uses no external resources. */
async function pageToPng(item) {
    const css = await documentCss();
    const page = render(item, getContext().name1);
    page.style.boxShadow = 'none';

    // Measure it in the live document at the width it would be shown at.
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:-10000px;top:0;width:720px;';
    probe.appendChild(page);
    document.body.appendChild(probe);
    const width = Math.ceil(page.getBoundingClientRect().width);
    const height = Math.ceil(page.getBoundingClientRect().height);
    probe.remove();

    const scale = 2;
    const xhtml = `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${width}px"><style>${css}</style>${page.outerHTML}</div>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%">${xhtml}</foreignObject></svg>`;
    // A data URI, not a blob URL: Chromium treats a blob-loaded SVG with foreignObject as tainting the canvas.
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

    try {
        const image = await new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('could not rasterise the page'));
            img.src = url;
        });
        const canvas = document.createElement('canvas');
        canvas.width = width * scale;
        canvas.height = height * scale;
        const ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);
        ctx.drawImage(image, 0, 0);
        return await new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('empty image'))), 'image/png'));
    } finally {
        // nothing to release for a data URI
    }
}

function saveBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    // Inside the open dialog: everything outside a modal dialog is inert, and an inert link won't download.
    (popup?.content ?? document.body).appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function exportItem(item, format) {
    const name = safeName(item);

    try {
        if (format === 'json') {
            const data = { kind: item.kind, source: item.source, title: item.title, date: item.date, from: item.from, to: item.to, found: item.found, body: item.body };
            saveBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `${name}.json`);
        } else if (format === 'html') {
            saveBlob(new Blob([await standaloneHtml(item)], { type: 'text/html' }), `${name}.html`);
        } else if (format === 'png') {
            saveBlob(await pageToPng(item), `${name}.png`);
        }
    } catch (error) {
        console.error(LOG, error);
        notify.error(String(error?.message ?? error));
    }
}

/* ---------------------------------------------------------------- UI */

function element(tag, className, text) {
    const node = document.createElement(tag);

    if (className) {
        node.className = className;
    }

    if (text !== undefined && text !== null) {
        node.textContent = text;
    }

    return node;
}

let badge = null;
let statusEl = null;

function setStatus(text) {
    if (statusEl) {
        statusEl.textContent = text;
    }
}

function unreadCount() {
    return (store()?.items ?? []).filter(i => i.status === 'unread').length;
}

function refreshBadge() {
    if (!badge) {
        return;
    }

    const n = unreadCount();
    badge.textContent = n ? String(n) : '';
    badge.classList.toggle('dsp-has', n > 0);
}

function addButtons() {
    // Wand menu entry.
    const menu = document.getElementById('extensionsMenu');

    if (menu && !document.getElementById('dsp-menu-item')) {
        const item = element('div', 'list-group-item flex-container flexGap5 interactable');
        item.id = 'dsp-menu-item';
        item.innerHTML = '<div class="fa-solid fa-inbox extensionsMenuExtensionButton"></div><span>Dispatch</span>';
        item.addEventListener('click', () => openTray());
        menu.appendChild(item);
    }

    // Envelope by the input with the unread count.
    const left = document.getElementById('leftSendForm');

    if (left && !document.getElementById('dsp-button')) {
        const button = element('div', 'fa-solid fa-inbox interactable');
        button.id = 'dsp-button';
        button.title = 'Dispatch: things in the world';
        badge = element('span', 'dsp-badge');
        button.appendChild(badge);
        button.addEventListener('click', () => openTray());
        left.appendChild(button);
        refreshBadge();
    }
}

let popup = null;
let view = { tab: 'tray', open: null };

async function openTray(tab = null) {
    if (tab) {
        view.tab = tab;
        view.open = null;
    }

    const root = element('div', 'dsp-root');
    statusEl = element('span', 'dsp-status');
    draw(root);

    if (popup) {
        popup.content.replaceChildren(root);
        return;
    }

    popup = new Popup(root, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, okButton: 'Close' });
    await popup.show();
    popup = null;
    statusEl = null;
}

function redraw() {
    if (popup) {
        const root = element('div', 'dsp-root');
        draw(root);
        popup.content.replaceChildren(root);
    }
}

function draw(root) {
    const data = store();
    const head = element('div', 'dsp-head');
    const tabs = element('div', 'dsp-tabs');

    for (const [key, label] of [['tray', 'In-tray'], ['library', 'Library'], ['new', 'New document'], ['time', 'Time passed']]) {
        const tab = element('span', 'dsp-tab' + (view.tab === key ? ' dsp-tab-on' : ''), label);

        if (key === 'tray' && unreadCount()) {
            tab.appendChild(element('span', 'dsp-tab-count', String(unreadCount())));
        }

        tab.addEventListener('click', () => { view.tab = key; view.open = null; redraw(); });
        tabs.appendChild(tab);
    }

    head.appendChild(tabs);
    head.appendChild(statusEl ?? (statusEl = element('span', 'dsp-status')));
    root.appendChild(head);

    const body = element('div', 'dsp-body');
    root.appendChild(body);

    if (!data) {
        body.appendChild(element('p', 'dsp-muted', 'Open a chat first.'));
        return;
    }

    if (view.open) {
        const item = data.items.find(i => i.id === view.open);

        if (item) {
            drawDocument(body, item);
            return;
        }

        view.open = null;
    }

    switch (view.tab) {
        case 'tray':
            drawList(body, data.items.filter(i => i.origin !== 'artefact'), 'Nothing has arrived yet. Things appear here when in-fiction time passes.');
            break;
        case 'library':
            drawList(body, data.items.filter(i => i.origin === 'artefact' || i.brought || i.filed), 'Nothing here yet. Documents you make, bring in, or file collect here.');
            break;
        case 'new':
            drawNewForm(body);
            break;
        case 'time':
            drawTimeForm(body);
            break;
    }
}

function drawList(body, items, emptyText) {
    if (!items.length) {
        body.appendChild(element('p', 'dsp-muted', emptyText));
        return;
    }

    const list = element('div', 'dsp-list');

    for (const item of items) {
        const row = element('div', 'dsp-row' + (item.status === 'unread' ? ' dsp-unread' : ''));
        const icon = element('span', 'fa-solid ' + (KINDS[item.kind]?.icon ?? 'fa-file') + ' dsp-row-icon');
        row.appendChild(icon);
        const text = element('div', 'dsp-row-text');
        text.appendChild(element('div', 'dsp-row-title', item.title || item.source));
        text.appendChild(element('div', 'dsp-row-sub', [KINDS[item.kind]?.label, item.source, item.date].filter(Boolean).join(' · ')));

        if (item.found && item.origin !== 'artefact') {
            text.appendChild(element('div', 'dsp-row-found', item.found));
        }

        row.appendChild(text);
        const flags = element('div', 'dsp-row-flags');

        if (item.brought) {
            flags.appendChild(element('span', 'dsp-flag', 'in scene'));
        }

        if (item.filed) {
            flags.appendChild(element('span', 'dsp-flag', 'filed'));
        }

        row.appendChild(flags);
        row.addEventListener('click', () => {
            view.open = item.id;

            if (item.status === 'unread') {
                item.status = 'read';
                saveStore();
                refreshBadge();
            }

            redraw();
        });
        list.appendChild(row);
    }

    body.appendChild(list);
}

function drawDocument(body, item) {
    const bar = element('div', 'dsp-docbar');
    const back = element('span', 'dsp-link', '← back');
    back.addEventListener('click', () => { view.open = null; redraw(); });
    bar.appendChild(back);

    const actions = element('div', 'dsp-actions');

    if (!item.brought) {
        const bring = element('button', 'menu_button', 'Bring into the scene');
        bring.title = 'On your next turn the narrator will know your character has read this.';
        bring.addEventListener('click', () => { bringIn(item); redraw(); });
        actions.appendChild(bring);
    } else {
        actions.appendChild(element('span', 'dsp-flag', 'in scene'));
    }

    if (!item.filed) {
        const file = element('button', 'menu_button', 'File to lorebook');
        file.title = 'Add it to this chat\'s lorebook so the model can find it later by its names.';
        file.addEventListener('click', async () => { await fileToLorebook(item); redraw(); });
        actions.appendChild(file);
    } else {
        actions.appendChild(element('span', 'dsp-flag', `filed in ${item.filed.book}`));
    }

    const copy = element('button', 'menu_button', 'Copy text');
    copy.addEventListener('click', () => navigator.clipboard?.writeText(plainText(item)).then(() => toastr.info('Copied.', 'Dispatch')));
    actions.appendChild(copy);

    const save = element('span', 'dsp-save');
    save.appendChild(element('span', 'dsp-save-label', 'Save as'));

    for (const [format, label, title] of [['html', 'HTML', 'A standalone page, styled, opens anywhere'], ['png', 'PNG', 'The rendered page as an image'], ['json', 'JSON', 'The document as the writer produced it']]) {
        const b = element('button', 'menu_button dsp-save-btn', label);
        b.title = title;
        b.addEventListener('click', () => exportItem(item, format));
        save.appendChild(b);
    }

    actions.appendChild(save);

    const remove = element('button', 'menu_button dsp-danger', 'Discard');
    remove.addEventListener('click', () => {
        const data = store();
        data.items = data.items.filter(i => i.id !== item.id);
        data.noteFor = (data.noteFor ?? []).filter(id => id !== item.id);

        if (data.readFor === item.id) {
            data.readFor = null;
            applyReadNote();
        }

        applyWorldNote();
        saveStore();
        refreshBadge();
        view.open = null;
        redraw();
    });
    actions.appendChild(remove);
    bar.appendChild(actions);
    body.appendChild(bar);

    if (item.found && item.origin !== 'artefact') {
        body.appendChild(element('div', 'dsp-found', item.found));
    }

    const frame = element('div', 'dsp-frame');
    frame.appendChild(render(item, getContext().name1));
    body.appendChild(frame);
}

function drawNewForm(body) {
    const form = element('div', 'dsp-form');
    const kind = element('select', 'text_pole');

    for (const key of KIND_KEYS) {
        const option = element('option', null, KINDS[key].label);
        option.value = key;
        kind.appendChild(option);
    }

    const author = element('input', 'text_pole');
    author.placeholder = 'Author or source (the Planet, GCPD, Barbara, a stranger)';
    const subject = element('input', 'text_pole');
    subject.placeholder = 'Subject (last night on the transit platform; the girl at the fence)';
    const notes = element('textarea', 'text_pole');
    notes.placeholder = 'Anything else: angle, length, what it must or must not know';
    notes.rows = 3;

    const row = (label, field) => {
        const r = element('label', 'dsp-field');
        r.appendChild(element('span', 'dsp-field-label', label));
        r.appendChild(field);
        return r;
    };

    form.appendChild(row('Kind', kind));
    form.appendChild(row('Author', author));
    form.appendChild(row('Subject', subject));
    form.appendChild(row('Notes', notes));

    const go = element('button', 'menu_button', 'Write it');
    go.addEventListener('click', async () => {
        go.disabled = true;
        const item = await artefact({ kind: kind.value, author: author.value.trim(), subject: subject.value.trim(), notes: notes.value.trim() });
        go.disabled = false;

        if (item) {
            view.tab = 'library';
            view.open = item.id;
            redraw();
        }
    });
    form.appendChild(go);
    form.appendChild(element('p', 'dsp-muted', 'Written from the chat so far, the card, your persona, and the lorebook entries that currently apply. It goes to the Library; nothing enters the story unless you bring it in or file it.'));
    body.appendChild(form);
}

function drawTimeForm(body) {
    const form = element('div', 'dsp-form');
    const data = store();
    form.appendChild(element('p', null, `Last known in-fiction time: ${data?.lastTime ?? 'unknown'}.`));
    const hours = element('input', 'text_pole');
    hours.type = 'number';
    hours.min = '1';
    hours.value = '12';
    const r = element('label', 'dsp-field');
    r.appendChild(element('span', 'dsp-field-label', 'Hours passed'));
    r.appendChild(hours);
    form.appendChild(r);
    const go = element('button', 'menu_button', 'Let the world move');
    go.addEventListener('click', async () => {
        go.disabled = true;
        await dispatch(Math.max(1, Number(hours.value) || 1), { manual: true });
        go.disabled = false;
        view.tab = 'tray';
        redraw();
    });
    form.appendChild(go);
    form.appendChild(element('p', 'dsp-muted', 'Use this when the narrator skipped time and nothing arrived, or when you want something to have happened. The narrator is told what is within reach on your next turn.'));
    body.appendChild(form);
}

/* ---------------------------------------------------------------- settings panel */

function addSettingsPanel() {
    const s = settings();
    const container = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');

    if (!container) {
        return;
    }

    const drawer = element('div', 'dsp-settings');
    drawer.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Dispatch</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label"><input type="checkbox" id="dsp-enabled"><span>Enabled</span></label>
                <label class="checkbox_label"><input type="checkbox" id="dsp-auto"><span>Let the world move on its own when time passes</span></label>
                <label>Time passed means at least <input type="number" id="dsp-threshold" min="1" max="720" class="text_pole dsp-num"> hours</label>
                <label>Documents per dispatch <input type="number" id="dsp-count" min="1" max="4" class="text_pole dsp-num"></label>
                <label>Recent messages the writer sees <input type="number" id="dsp-recent" min="2" max="60" class="text_pole dsp-num"></label>
                <label>Writer runs on
                    <select id="dsp-source" class="text_pole">
                        <option value="main">the chat's connection, prompt sent straight (no preset)</option>
                        <option value="profile">a connection profile</option>
                        <option value="custom">an OpenAI-compatible URL and model</option>
                    </select>
                </label>
                <div id="dsp-source-profile" class="dsp-sub"><label>Profile <select id="dsp-profile" class="text_pole"></select></label></div>
                <div id="dsp-source-custom" class="dsp-sub">
                    <label>Base URL <input type="text" id="dsp-custom-url" class="text_pole" placeholder="https://api.example.com/v1"></label>
                    <label>Model <input type="text" id="dsp-custom-model" class="text_pole" placeholder="glm-4.5-flash"></label>
                    <label>API key <input type="password" id="dsp-custom-key" class="text_pole" placeholder="optional; stored in your settings file"></label>
                    <label>Extra request body (YAML) <textarea id="dsp-custom-body" class="text_pole" rows="2" placeholder="thinking:&#10;  type: disabled"></textarea></label>
                    <small>Merged into the request. For DeepSeek and most thinking models, <code>thinking: {type: disabled}</code> turns thinking off so the budget goes on the document.</small>
                </div>
                <label>Temperature <input type="text" id="dsp-temperature" class="text_pole dsp-num" placeholder="default"> (blank leaves the endpoint's default)</label>
                <label>Max tokens for the writer <input type="number" id="dsp-tokens" min="300" max="16000" class="text_pole dsp-num"></label>
                <label>Console logging
                    <select id="dsp-logging" class="text_pole dsp-select">
                        <option value="normal">normal: events and errors</option>
                        <option value="verbose">verbose: also the full request and the raw answer</option>
                    </select>
                </label>
                <div class="dsp-buttons">
                    <button id="dsp-save" class="menu_button">Save settings</button>
                    <button id="dsp-test" class="menu_button">Test the writer</button>
                    <span id="dsp-test-result" class="dsp-muted"></span>
                </div>
                <small>When in-fiction time passes (the reply's state comment moves its clock, or you write that time passed), the world writes what came into existence: a paper, a text, a note. The narrator is told only that it is within reach. Read it in the in-tray; bring it in if you want your character to have read it; file it to make it part of the chat's lorebook.</small>
            </div>
        </div>`;
    container.appendChild(drawer);

    const q = (id) => drawer.querySelector(id);
    q('#dsp-enabled').checked = s.enabled;
    q('#dsp-auto').checked = s.auto;
    q('#dsp-threshold').value = s.thresholdHours;
    q('#dsp-count').value = s.count;
    q('#dsp-recent').value = s.recent;
    q('#dsp-tokens').value = s.maxTokens;

    const profile = q('#dsp-profile');
    const source = q('#dsp-source');

    try {
        const profiles = getContext().extensionSettings?.connectionManager?.profiles ?? [];

        for (const p of profiles) {
            const option = element('option', null, p.name);
            option.value = p.id;
            profile.appendChild(option);
        }
    } catch (error) {
        console.debug(LOG, 'no profiles', error);
    }

    profile.value = s.profile;
    source.value = s.source;
    q('#dsp-custom-url').value = s.customUrl;
    q('#dsp-custom-model').value = s.customModel;
    q('#dsp-custom-key').value = s.customKey;
    q('#dsp-custom-body').value = s.customBody;
    q('#dsp-temperature').value = s.temperature;
    q('#dsp-logging').value = s.logging;

    const showSub = () => {
        q('#dsp-source-profile').style.display = source.value === 'profile' ? '' : 'none';
        q('#dsp-source-custom').style.display = source.value === 'custom' ? '' : 'none';
    };

    showSub();

    const readAll = () => {
        s.enabled = q('#dsp-enabled').checked;
        s.auto = q('#dsp-auto').checked;
        s.thresholdHours = Math.max(1, Number(q('#dsp-threshold').value) || 3);
        s.count = Math.max(1, Math.min(4, Number(q('#dsp-count').value) || 1));
        s.recent = Math.max(2, Math.min(60, Number(q('#dsp-recent').value) || 12));
        s.maxTokens = Math.max(300, Math.min(16000, Number(q('#dsp-tokens').value) || 4000));
        s.source = source.value;
        s.profile = profile.value;
        s.customUrl = q('#dsp-custom-url').value.trim();
        s.customModel = q('#dsp-custom-model').value.trim();
        s.customKey = q('#dsp-custom-key').value.trim();
        s.customBody = q('#dsp-custom-body').value.trim();
        const t = q('#dsp-temperature').value.trim();
        s.temperature = t === '' || Number.isNaN(Number(t)) ? '' : Number(t);
        s.logging = q('#dsp-logging').value;
        saveSettings();
    };

    q('#dsp-save').addEventListener('click', async () => {
        readAll();
        await saveSettingsNow();
        notify.success('Saved.');
    });

    q('#dsp-test').addEventListener('click', async () => {
        readAll();
        const out = q('#dsp-test-result');
        const button = q('#dsp-test');
        button.disabled = true;
        out.textContent = 'asking…';
        const where = s.source === 'custom' ? `${s.customUrl} / ${s.customModel}` : s.source === 'profile' ? `profile ${profileName(s.profile)}` : 'the chat connection';
        console.info(LOG, `test: asking ${where} for a one-word answer (50 tokens)`);

        try {
            const started = Date.now();
            const answer = await writer.call([{ role: 'user', content: 'Reply with the single word OK and nothing else.' }], 50);
            const text = String(answer ?? '').trim();
            const seconds = ((Date.now() - started) / 1000).toFixed(1);
            const verdict = text
                ? `answered in ${seconds}s: "${text.slice(0, 60)}"`
                : `connected, but the answer was empty after ${seconds}s${writer.lastReasoning ? ` (it reasoned for ${writer.lastReasoning.length} chars instead: thinking is on)` : ''}`;
            out.textContent = verdict;
            (text ? notify.success : notify.warning)(`Test: ${verdict}`);
        } catch (error) {
            out.textContent = `failed: ${error?.message ?? error}`;
            notify.error(`Test failed: ${error?.message ?? error}`);
        } finally {
            button.disabled = false;
        }
    });

    source.addEventListener('change', () => { s.source = source.value; saveSettings(); showSub(); });
    q('#dsp-custom-url').addEventListener('change', (e) => { s.customUrl = e.target.value.trim(); saveSettings(); });
    q('#dsp-custom-model').addEventListener('change', (e) => { s.customModel = e.target.value.trim(); saveSettings(); });
    q('#dsp-custom-key').addEventListener('change', (e) => { s.customKey = e.target.value.trim(); saveSettings(); });
    q('#dsp-custom-body').addEventListener('change', (e) => { s.customBody = e.target.value.trim(); saveSettings(); });
    q('#dsp-logging').addEventListener('change', (e) => { s.logging = e.target.value; saveSettings(); });
    q('#dsp-temperature').addEventListener('change', (e) => { const v = e.target.value.trim(); s.temperature = v === '' || Number.isNaN(Number(v)) ? '' : Number(v); e.target.value = s.temperature; saveSettings(); });

    q('#dsp-enabled').addEventListener('change', (e) => { s.enabled = e.target.checked; saveSettings(); applyWorldNote(); applyReadNote(); });
    q('#dsp-auto').addEventListener('change', (e) => { s.auto = e.target.checked; saveSettings(); });
    q('#dsp-threshold').addEventListener('change', (e) => { s.thresholdHours = Math.max(1, Number(e.target.value) || 3); e.target.value = s.thresholdHours; saveSettings(); });
    q('#dsp-count').addEventListener('change', (e) => { s.count = Math.max(1, Math.min(4, Number(e.target.value) || 1)); e.target.value = s.count; saveSettings(); });
    q('#dsp-recent').addEventListener('change', (e) => { s.recent = Math.max(2, Math.min(60, Number(e.target.value) || 12)); e.target.value = s.recent; saveSettings(); });
    q('#dsp-tokens').addEventListener('change', (e) => { s.maxTokens = Math.max(300, Math.min(16000, Number(e.target.value) || 4000)); e.target.value = s.maxTokens; saveSettings(); });
    profile.addEventListener('change', (e) => { s.profile = e.target.value; saveSettings(); });
}

/* ---------------------------------------------------------------- slash commands */

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dispatch',
        helpString: 'Open the in-tray, or <code>/dispatch hours=12</code> to let the world move.',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({ name: 'hours', description: 'in-fiction hours that passed', typeList: [ARGUMENT_TYPE.NUMBER], isRequired: false }),
        ],
        callback: async (args) => {
            if (args?.hours) {
                const docs = await dispatch(Number(args.hours), { manual: true });
                return String(docs.length);
            }

            openTray();
            return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'artefact',
        helpString: 'Write a document: <code>/artefact kind=article author="The Planet" subject="last night"</code>',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({ name: 'kind', description: KIND_KEYS.join(', '), typeList: [ARGUMENT_TYPE.STRING], isRequired: true }),
            SlashCommandNamedArgument.fromProps({ name: 'author', typeList: [ARGUMENT_TYPE.STRING], isRequired: false }),
            SlashCommandNamedArgument.fromProps({ name: 'subject', typeList: [ARGUMENT_TYPE.STRING], isRequired: false }),
        ],
        unnamedArgumentList: [new SlashCommandArgument('notes', [ARGUMENT_TYPE.STRING], false)],
        callback: async (args, notes) => {
            const item = await artefact({ kind: String(args.kind), author: args.author ?? '', subject: args.subject ?? '', notes: String(notes ?? '') });

            if (item) {
                view.tab = 'library';
                view.open = item.id;
                openTray();
            }

            return item ? item.id : '';
        },
    }));
}

/* ---------------------------------------------------------------- wiring */

function init() {
    settings();
    addSettingsPanel();
    registerSlashCommands();

    eventSource.on(event_types.APP_READY, () => { addButtons(); refreshBadge(); });
    eventSource.on(event_types.CHAT_CHANGED, () => { store(); applyWorldNote(); applyReadNote(); refreshBadge(); });
    eventSource.on(event_types.MESSAGE_RECEIVED, (id) => onReply(Number(id)));
    eventSource.on(event_types.MESSAGE_DELETED, () => refreshBadge());
    setTimeout(addButtons, 0);
    console.log(LOG, 'ready');
}

/** For tests and other extensions. */
globalThis.Dispatch = { dispatch, artefact, writer, store, settings, openTray, KINDS };

init();
