/**
 * Document kinds, the prompts that produce them, parsing the model's answer, and rendering.
 * No SillyTavern imports; the index passes in what it needs.
 */

/** What the world can produce. `found` describes how the user's character comes across it. */
export const KINDS = {
    article: {
        label: 'News article',
        icon: 'fa-newspaper',
        guide: 'A newspaper or news-site piece: outlet, headline, dateline, byline, two to five short paragraphs in that outlet\'s house style. Reported facts are what a journalist could have learned, slightly wrong where the world would get them wrong.',
        found: 'a stall, a rack by the till, a screen in a window, a paper left on a seat, someone reading it aloud',
    },
    broadcast: {
        label: 'TV / radio',
        icon: 'fa-tv',
        guide: 'A transcript of a short television or radio segment: station, programme, presenter lines and any interview, with the stage directions a transcript would carry in brackets. Ninety seconds of air time at most.',
        found: 'a TV over a bar or counter, a car radio, a phone playing it, a shop window',
    },
    text: {
        label: 'Text thread',
        icon: 'fa-comment-sms',
        guide: 'A phone message thread: sender, their relationship to the recipient, and three to eight messages with timestamps, in the sender\'s own voice and spelling. The recipient\'s replies, if any, are only ones they have already sent in the story; never write new ones.',
        found: 'the phone buzzing, a notification seen later, a message left unread',
    },
    voicemail: {
        label: 'Voicemail',
        icon: 'fa-voicemail',
        guide: 'A transcript of one voicemail: caller, time, duration, and what they said, with the hesitations and background noise a real message has. Under 120 words.',
        found: 'a missed-call notification, a phone picked up later',
    },
    note: {
        label: 'Note',
        icon: 'fa-note-sticky',
        guide: 'A short handwritten or typed note: who left it, where, and what it says. Under 80 words. Includes what it is written on.',
        found: 'under a door, on a windscreen, pinned to a board, in a pocket, left on a table',
    },
    letter: {
        label: 'Letter',
        icon: 'fa-envelope',
        guide: 'A letter: sender, recipient, date, salutation, body, sign-off. In the sender\'s voice and register; what they would commit to paper, not what they would say aloud.',
        found: 'post, a hand-delivered envelope, something found among other papers',
    },
    file: {
        label: 'Official file',
        icon: 'fa-folder-open',
        guide: 'An official record: the agency or institution, case or reference number, subject, date, and the fields such a document would have (status, summary, observations, actions, officer or author). Dry, procedural, with the gaps and errors an institution would actually have.',
        found: 'a desk, a folder left open, a screen, a leak, a copy handed over',
    },
    diary: {
        label: 'Diary page',
        icon: 'fa-book',
        guide: 'One diary or journal entry by a named character other than the user\'s: date, and what they wrote that day, in their private voice. What they would write and not say. Under 250 words.',
        found: 'a notebook left out, a page torn free, a locked drawer',
    },
    poster: {
        label: 'Poster / flyer',
        icon: 'fa-sign-hanging',
        guide: 'A poster, flyer, or notice: headline, body text, who put it up, contact or location details, and the condition it is in. Under 100 words.',
        found: 'a wall, a lamppost, a shop window, a noticeboard, a pile by a door',
    },
};

export const KIND_KEYS = Object.keys(KINDS);

/** The system instruction for making documents. `n` documents; `mode` is 'dispatch' or 'artefact'. */
export function systemPrompt({ mode, n, userName }) {
    const kinds = KIND_KEYS.map(k => `- ${k}: ${KINDS[k].guide} Where found: ${KINDS[k].found}.`).join('\n');
    const base = `You produce documents that exist inside a story's world. You are not the narrator and you do not continue the story; you write the things that would exist in the world at this point in it: what a newspaper printed, what a phone received, what a file says.

Rules:
- Everything is in-world. No narrator, no commentary, no address to the reader, nothing about the story being a story.
- Content comes from the story so far and the reference material. Offscreen events are plausible consequences of what has happened and what the people in the world want; name them specifically.
- Information travels the way it would: a paper knows what a reporter could learn; a text knows what the sender knows; a file knows what the institution recorded. Get things slightly wrong the way the world would, and never reveal what nobody could know.
- Never write ${userName}'s dialogue, thoughts, decisions, or replies. ${userName} may be the subject of a document, never its author, unless explicitly asked for a document ${userName} already wrote in the story.
- Match register to source: a tabloid is not a broadsheet, a cop's file is not a doctor's, a teenager's text is not a lawyer's letter.
- Keep each document the length its kind allows.

Kinds:
${kinds}

Answer with a JSON array and nothing else. Each item:
{"kind": one of the kind keys, "source": who or what produced it, short (the outlet, agency, or sender's name; not a description), "title": a short title or headline or subject, "date": in-world date or time as the document itself would show it, "from": author or sender or null, "to": recipient or null, "found": one sentence on how ${userName} could come across it in the scene, in the world's own terms, "keys": 3 to 6 short terms that would plausibly come up in later conversation about this document — people, places, organisations, objects, events — each one to three words, never the title, never ${userName}, "body": the document's full text, with newlines as \\n}
`;

    if (mode === 'dispatch') {
        return base + `\nProduce exactly ${n} document${n === 1 ? '' : 's'} that came into existence during the time that just passed, each of a different kind, each something ${userName} could plausibly encounter where they now are. Prefer consequence over coincidence: things set in motion earlier arriving, people reacting to what ${userName} did, the world's own business carrying on.`;
    }

    return base + `\nProduce exactly ${n} document${n === 1 ? '' : 's'} as requested below. Follow the request's kind, author, and subject exactly.`;
}

/** The user-turn content: reference material, recent story, and the request. */
export function userPrompt({ reference, story, request }) {
    const parts = [];

    if (reference) {
        parts.push(`<reference>\n${reference}\n</reference>`);
    }

    parts.push(`<story_so_far>\n${story}\n</story_so_far>`);
    parts.push(request);
    return parts.join('\n\n');
}

/** Pull a JSON array out of the model's answer, tolerating fences and stray text. */
export function parseDocuments(text) {
    const raw = String(text ?? '').trim();
    const candidates = [];
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);

    if (fenced) {
        candidates.push(fenced[1]);
    }

    const first = raw.indexOf('[');
    const last = raw.lastIndexOf(']');

    if (first >= 0 && last > first) {
        candidates.push(raw.slice(first, last + 1));
    }

    const firstObj = raw.indexOf('{');
    const lastObj = raw.lastIndexOf('}');

    if (firstObj >= 0 && lastObj > firstObj) {
        candidates.push('[' + raw.slice(firstObj, lastObj + 1) + ']');
    }

    for (const candidate of candidates) {
        const docs = tryParse(candidate) ?? tryParse(escapeControlChars(candidate));

        if (docs?.length) {
            return docs;
        }
    }

    // Still nothing: the answer was probably cut off. Take every complete object we can find.
    const salvaged = balancedObjects(escapeControlChars(raw)).map(tryParse).flat().filter(Boolean);
    return salvaged.length ? salvaged : [];
}

function tryParse(text) {
    try {
        const value = JSON.parse(text);
        const list = Array.isArray(value) ? value : [value];
        return list.map(normalise).filter(Boolean);
    } catch {
        return null;
    }
}

/** Raw newlines and tabs inside JSON strings, which models write and JSON.parse refuses. */
function escapeControlChars(text) {
    let out = '';
    let inString = false;
    let escaped = false;

    for (const ch of String(text)) {
        if (inString) {
            if (escaped) {
                escaped = false;
                out += ch;
            } else if (ch === '\\') {
                escaped = true;
                out += ch;
            } else if (ch === '"') {
                inString = false;
                out += ch;
            } else if (ch === '\n') {
                out += '\\n';
            } else if (ch === '\r') {
                out += '\\r';
            } else if (ch === '\t') {
                out += '\\t';
            } else {
                out += ch;
            }
        } else {
            if (ch === '"') {
                inString = true;
            }

            out += ch;
        }
    }

    return out;
}

/** Every top-level {...} with balanced braces, ignoring braces inside strings. Incomplete trailing objects are dropped. */
function balancedObjects(text) {
    const found = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }

            continue;
        }

        if (ch === '"') {
            inString = true;
        } else if (ch === '{') {
            if (depth === 0) {
                start = i;
            }

            depth++;
        } else if (ch === '}') {
            depth--;

            if (depth === 0 && start >= 0) {
                found.push(text.slice(start, i + 1));
                start = -1;
            }
        }
    }

    return found;
}

function normalise(raw) {
    if (!raw || typeof raw !== 'object') {
        return null;
    }

    const body = String(raw.body ?? raw.text ?? raw.content ?? '').trim();

    if (!body) {
        return null;
    }

    const kind = KIND_KEYS.includes(String(raw.kind).toLowerCase()) ? String(raw.kind).toLowerCase() : 'note';
    return {
        kind,
        source: String(raw.source ?? raw.outlet ?? raw.sender ?? '').trim() || KINDS[kind].label,
        title: String(raw.title ?? raw.headline ?? raw.subject ?? '').trim(),
        date: String(raw.date ?? raw.time ?? '').trim(),
        from: raw.from ? String(raw.from).trim() : null,
        to: raw.to ? String(raw.to).trim() : null,
        found: String(raw.found ?? raw.where ?? '').trim(),
        keys: cleanKeys(Array.isArray(raw.keys) ? raw.keys : typeof raw.keys === 'string' ? raw.keys.split(/[,;]/) : []),
        body,
    };
}

function cleanKeys(list) {
    const out = [];

    for (const raw of list) {
        const key = String(raw ?? '').replace(/[,"]/g, ' ').replace(/\s+/g, ' ').trim();

        if (key && key.length <= 40 && !out.some(k => k.toLowerCase() === key.toLowerCase())) {
            out.push(key);
        }
    }

    return out.slice(0, 8);
}

const STOP = new Set(['The', 'A', 'An', 'And', 'But', 'Or', 'For', 'Nor', 'So', 'Yet', 'In', 'On', 'At', 'To', 'By', 'Of', 'From', 'With', 'As', 'If', 'When', 'While', 'After', 'Before', 'Then', 'There', 'This', 'That', 'These', 'Those', 'It', 'Its', 'He', 'She', 'They', 'We', 'You', 'I', 'His', 'Her', 'Their', 'Our', 'Your', 'My', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'Yesterday', 'Today', 'Tomorrow', 'Morning', 'Evening', 'Night', 'Re', 'Ref', 'Status', 'Subject', 'Summary', 'Observations', 'Actions', 'Author', 'Location', 'Date', 'From', 'To']);

/**
 * Lorebook keys for a document: the writer's, or proper nouns from the text (runs of capitalised words),
 * never the whole title. `exclude` holds names that should not be keys (the user's).
 */
export function lorebookKeys(doc, exclude = []) {
    const banned = new Set(exclude.map(e => String(e).toLowerCase()).filter(Boolean));
    const keys = cleanKeys(doc.keys ?? []).filter(k => !banned.has(k.toLowerCase()));

    if (keys.length >= 2) {
        return keys;
    }

    const segments = [doc.from, doc.to, doc.body].filter(Boolean).join('\n').split(/[\n\r]+|(?<=[.!?:;—–])\s+|\s[-–—]\s/);
    const counts = new Map();
    const runs = /\b([A-Z][\w'’.-]*(?:[ \t]+(?:of|the|de|van|von|al)[ \t]+)?(?:[ \t]+[A-Z][\w'’.-]*){0,3})\b/g;
    let m;
    const text = segments.join('\n');

    while ((m = runs.exec(text)) !== null) {
        const words = m[1].split(/\s+/).filter(w => !STOP.has(w.replace(/[.'’-]+$/, '')) && !(w.length > 3 && w === w.toUpperCase()));

        if (!words.length) {
            continue;
        }

        const key = words.join(' ').replace(/[.,;:]+$/, '');

        if (key.length < 3 || key.length > 40 || banned.has(key.toLowerCase())) {
            continue;
        }

        counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const extracted = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).map(([k]) => k);
    const merged = cleanKeys([...keys, doc.source, ...extracted]).filter(k => !banned.has(k.toLowerCase()));
    return merged.slice(0, 6);
}

/** A one-line description for the in-tray and for telling the narrator what's around. */
export function summary(doc) {
    const head = doc.title || doc.source;
    return `${KINDS[doc.kind]?.label ?? doc.kind}: ${head}`;
}

/** Plain text of a document, for injection and for filing. */
export function plainText(doc) {
    const lines = [];
    lines.push(`[${KINDS[doc.kind]?.label ?? doc.kind}] ${doc.source}${doc.date ? ` — ${doc.date}` : ''}`);

    if (doc.title) {
        lines.push(doc.title);
    }

    if (doc.from || doc.to) {
        lines.push([doc.from ? `From: ${doc.from}` : null, doc.to ? `To: ${doc.to}` : null].filter(Boolean).join('   '));
    }

    lines.push('');
    lines.push(doc.body);
    return lines.join('\n');
}

/* ---------------------------------------------------------------- rendering */

function el(tag, className, text) {
    const node = document.createElement(tag);

    if (className) {
        node.className = className;
    }

    if (text !== undefined && text !== null) {
        node.textContent = text;
    }

    return node;
}

function paragraphs(container, body, className = 'dsp-p') {
    for (const para of String(body).split(/\n{2,}|\r?\n(?=\S)/)) {
        const text = para.trim();

        if (text) {
            container.appendChild(el('p', className, text));
        }
    }
}

/** Render a document as a styled page element. */
export function render(doc, userName) {
    const page = el('div', `dsp-doc dsp-${doc.kind}`);

    switch (doc.kind) {
        case 'article': {
            const masthead = el('div', 'dsp-masthead', doc.source);
            page.appendChild(masthead);
            page.appendChild(el('div', 'dsp-dateline', doc.date));
            page.appendChild(el('h1', 'dsp-headline', doc.title || 'Untitled'));

            if (doc.from) {
                page.appendChild(el('div', 'dsp-byline', `By ${doc.from}`));
            }

            const cols = el('div', 'dsp-columns');
            paragraphs(cols, doc.body);
            page.appendChild(cols);
            break;
        }

        case 'broadcast': {
            page.appendChild(el('div', 'dsp-station', doc.source));
            page.appendChild(el('div', 'dsp-programme', [doc.title, doc.date].filter(Boolean).join(' · ')));
            const script = el('div', 'dsp-transcript');

            for (const line of doc.body.split(/\r?\n/)) {
                const text = line.trim();

                if (!text) {
                    continue;
                }

                const cue = /^\[(.+)\]$/.exec(text) || /^\((.+)\)$/.exec(text);
                const speaker = /^([A-Z][A-Za-z .'-]{1,40}):\s*(.+)$/.exec(text);

                if (cue) {
                    script.appendChild(el('div', 'dsp-cue', cue[1]));
                } else if (speaker) {
                    const row = el('div', 'dsp-line');
                    row.appendChild(el('span', 'dsp-speaker', speaker[1]));
                    row.appendChild(el('span', 'dsp-speech', speaker[2]));
                    script.appendChild(row);
                } else {
                    script.appendChild(el('div', 'dsp-speech', text));
                }
            }

            page.appendChild(script);
            break;
        }

        case 'text': {
            page.appendChild(el('div', 'dsp-contact', doc.from || doc.source));
            const thread = el('div', 'dsp-thread');

            for (const line of doc.body.split(/\r?\n/)) {
                const text = line.trim();

                if (!text) {
                    continue;
                }

                const stamped = /^\[?(\d{1,2}:\d{2}(?:\s*[ap]m)?|[A-Za-z]{3,9} \d{1,2}:\d{2}[^\]]*)\]?\s*[-–—:]?\s*(?:([^:]{1,30}):\s*)?(.+)$/.exec(text);
                const who = stamped?.[2] ?? (/^([^:]{1,30}):\s*(.+)$/.exec(text)?.[1] ?? null);
                const body = stamped?.[3] ?? (/^([^:]{1,30}):\s*(.+)$/.exec(text)?.[2] ?? text);
                const mine = who && userName && who.trim().toLowerCase() === String(userName).trim().toLowerCase();
                const bubble = el('div', 'dsp-bubble' + (mine ? ' dsp-mine' : ''));
                bubble.appendChild(el('div', 'dsp-bubble-text', body));

                if (stamped?.[1]) {
                    bubble.appendChild(el('div', 'dsp-bubble-time', stamped[1]));
                }

                thread.appendChild(bubble);
            }

            page.appendChild(thread);
            break;
        }

        case 'voicemail': {
            page.appendChild(el('div', 'dsp-vm-head', `Voicemail · ${doc.from || doc.source}`));
            page.appendChild(el('div', 'dsp-vm-meta', doc.date));
            const wave = el('div', 'dsp-wave');

            for (let i = 0; i < 40; i++) {
                const bar = el('span');
                bar.style.height = `${4 + Math.round(Math.abs(Math.sin(i * 1.7) * 14 + Math.cos(i * 0.6) * 6))}px`;
                wave.appendChild(bar);
            }

            page.appendChild(wave);
            paragraphs(page, doc.body, 'dsp-vm-text');
            break;
        }

        case 'note': {
            page.appendChild(el('div', 'dsp-note-text', doc.body));

            if (doc.from) {
                page.appendChild(el('div', 'dsp-note-sign', doc.from));
            }

            break;
        }

        case 'letter': {
            page.appendChild(el('div', 'dsp-letter-date', doc.date));
            paragraphs(page, doc.body, 'dsp-letter-p');

            if (doc.from) {
                page.appendChild(el('div', 'dsp-letter-sign', doc.from));
            }

            break;
        }

        case 'file': {
            const head = el('div', 'dsp-file-head');
            head.appendChild(el('div', 'dsp-file-agency', doc.source));
            head.appendChild(el('div', 'dsp-file-ref', doc.date));
            page.appendChild(head);
            page.appendChild(el('div', 'dsp-file-subject', doc.title));
            const table = el('div', 'dsp-file-body');

            for (const line of doc.body.split(/\r?\n/)) {
                const text = line.trim();

                if (!text) {
                    continue;
                }

                const field = /^([A-Z][A-Za-z /&()-]{1,40}):\s*(.*)$/.exec(text);

                if (field) {
                    const row = el('div', 'dsp-file-row');
                    row.appendChild(el('span', 'dsp-file-key', field[1]));
                    row.appendChild(el('span', 'dsp-file-val', field[2]));
                    table.appendChild(row);
                } else {
                    table.appendChild(el('div', 'dsp-file-text', text));
                }
            }

            page.appendChild(table);
            page.appendChild(el('div', 'dsp-stamp', 'COPY'));
            break;
        }

        case 'diary': {
            page.appendChild(el('div', 'dsp-diary-date', doc.date));
            paragraphs(page, doc.body, 'dsp-diary-p');
            break;
        }

        case 'poster': {
            page.appendChild(el('h1', 'dsp-poster-title', doc.title || doc.source));
            paragraphs(page, doc.body, 'dsp-poster-p');

            if (doc.from) {
                page.appendChild(el('div', 'dsp-poster-from', doc.from));
            }

            break;
        }

        default:
            paragraphs(page, doc.body);
    }

    return page;
}
