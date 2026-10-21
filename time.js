/**
 * Working out whether in-fiction time has passed. Pure functions, no SillyTavern imports.
 *
 * Two sources: the `time:` line of the state comment a reply ends with, and what the user wrote
 * ("two days later", "I sleep", "(skip to morning)"). Both are heuristics; a button exists for
 * when neither catches it.
 */

const STATE = /<!--\s*state\b([\s\S]*?)-->/i;
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, couple: 2, few: 3, several: 4, half: 0.5 };
const UNIT_HOURS = { minute: 1 / 60, hour: 1, day: 24, night: 12, week: 168, month: 720, year: 8760 };

/** The `time:` value from a reply's state comment, or null. */
export function timeLine(text) {
    const block = STATE.exec(String(text ?? ''));

    if (!block) {
        return null;
    }

    const line = block[1].split(/\r?\n/).map(l => l.trim()).find(l => /^time\s*:/i.test(l));

    if (!line) {
        return null;
    }

    return line.replace(/^time\s*:\s*/i, '').split(/\s\|\s/)[0].trim() || null;
}

function number(word) {
    if (/^\d+(\.\d+)?$/.test(word)) {
        return Number(word);
    }

    return WORDS[word.toLowerCase()] ?? null;
}

/**
 * Hours implied by a phrase like "three hours later", "the next morning", "two days pass",
 * "overnight", "a week later". 0 when nothing in the text says time moved.
 */
export function hoursInPhrase(text) {
    const t = String(text ?? '').toLowerCase();
    let hours = 0;
    // A state-comment line written as a duration ("elapsed: two days", "+3 hours") is itself a skip.
    const duration = /^\s*(elapsed|\+|about|roughly|some)\b/.test(t) || /\bsince the last (entry|reply|scene)\b/.test(t);

    const spans = /\b(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|couple of|few|several|half an?)\s+(minute|hour|day|night|week|month|year)s?\b(?:\s+(?:later|pass(?:es|ed)?|go(?:es)? by|on|after|afterwards))?/g;
    let m;

    while ((m = spans.exec(t)) !== null) {
        const n = number(m[1].replace(/ of$/, '').replace(/^half an?$/, 'half'));
        const after = t.slice(m.index + m[0].length, m.index + m[0].length + 24);
        const before = t.slice(Math.max(0, m.index - 12), m.index);
        // "three hours ago", "for two hours", "every few days" are not skips; anything else that names a span is.
        const passes = !/\bago\b/.test(after.slice(0, 6)) && !/\b(for|been|within|every|each|in|about)\s*$/.test(before);

        if (n !== null && (passes || duration)) {
            hours = Math.max(hours, n * UNIT_HOURS[m[2]]);
        }
    }

    if (/\b(the )?next (morning|day|evening|night|afternoon)\b|\bovernight\b|\bby morning\b|\bcome morning\b|\bthat night\b.*\bmorning\b|\bthe following (day|morning)\b/.test(t)) {
        hours = Math.max(hours, 10);
    }

    if (/\b(the )?next week\b|\ba week (later|passes|goes by)\b/.test(t)) {
        hours = Math.max(hours, 168);
    }

    if (/\b(i|we|she|he|they) (go(es)? to )?(sleep|bed)\b|\bsleeps? (through|until)\b|\bturns? in for the night\b/.test(t)) {
        hours = Math.max(hours, 8);
    }

    if (/\b(later that|that same) (day|evening|night)\b|\bhours later\b|\bsome time later\b|\blater,? (that|in the)\b/.test(t)) {
        hours = Math.max(hours, 3);
    }

    if (/\(\s*(ooc\s*:)?\s*(skip|time ?skip|fast.?forward|montage)\b/.test(t)) {
        hours = Math.max(hours, 6);
    }

    return hours;
}

/** A rough point on a timeline from a state-comment time string: { day, hour }, or null. */
export function parseClock(text) {
    const t = String(text ?? '').toLowerCase();

    if (!t) {
        return null;
    }

    let hour = null;
    const h12 = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/.exec(t);
    const h24 = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(t);

    if (h12) {
        hour = (Number(h12[1]) % 12) + (h12[3].startsWith('p') ? 12 : 0) + (h12[2] ? Number(h12[2]) / 60 : 0);
    } else if (h24) {
        hour = Number(h24[1]) + Number(h24[2]) / 60;
    } else if (/\bmidnight\b/.test(t)) {
        hour = 0;
    } else if (/\bdawn\b|\bsunrise\b|\bearly morning\b/.test(t)) {
        hour = 6;
    } else if (/\bmorning\b/.test(t)) {
        hour = 9;
    } else if (/\bnoon\b|\bmidday\b/.test(t)) {
        hour = 12;
    } else if (/\bafternoon\b/.test(t)) {
        hour = 15;
    } else if (/\bdusk\b|\bsunset\b|\bevening\b/.test(t)) {
        hour = 19;
    } else if (/\bnight\b|\blate\b/.test(t)) {
        hour = 23;
    }

    let day = null;
    const weekday = DAYS.findIndex(d => t.includes(d));
    const date = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})\b/.exec(t);
    const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(t);

    if (iso) {
        day = Math.round(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])) / 86400000);
    } else if (date) {
        const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
        const month = months.indexOf((date[2] ?? date[3]).slice(0, 3));
        const d = Number(date[1] ?? date[4]);
        day = Math.round(Date.UTC(2000, month, d) / 86400000);
    } else if (weekday >= 0) {
        day = weekday; // only comparable with another weekday
        return { day, hour, weekday: true };
    }

    if (day === null && hour === null) {
        return null;
    }

    return { day, hour, weekday: false };
}

/**
 * Hours between two state-comment time strings, or null when they can't be compared.
 * "Elapsed: three hours" style lines are handled by hoursInPhrase instead.
 */
export function hoursBetween(before, after) {
    const a = parseClock(before);
    const b = parseClock(after);

    if (!a || !b) {
        return null;
    }

    let days = 0;

    if (a.day !== null && b.day !== null) {
        if (a.weekday && b.weekday) {
            days = (b.day - a.day + 7) % 7;
        } else if (!a.weekday && !b.weekday) {
            days = b.day - a.day;
        } else {
            days = 0;
        }
    }

    if (a.hour === null || b.hour === null) {
        return days ? days * 24 : null;
    }

    let hours = days * 24 + (b.hour - a.hour);

    if (hours < 0 && days === 0) {
        hours += 24; // the clock went round
    }

    return Math.max(0, hours);
}

/**
 * Hours that passed between one reply and the next, from the best evidence available:
 * an "elapsed" phrase in the new time line, the difference between the two clocks, or
 * what the user wrote in between.
 */
export function elapsed({ previousTime, currentTime, userText }) {
    const fromLine = hoursInPhrase(currentTime);
    const fromClocks = hoursBetween(previousTime, currentTime);
    const fromUser = hoursInPhrase(userText);
    return Math.max(fromLine, fromClocks ?? 0, fromUser);
}
