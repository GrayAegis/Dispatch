/**
 * The period a story is set in, and the year it implies. Pure functions, no SillyTavern imports.
 *
 * A period is free text ("1994, Tokyo", "the 90s", "Victorian London", "Remnant"). When a year can
 * be read out of it, kinds of document that did not exist yet are removed in code; either way the
 * writer and the narrator are told the period and held to it.
 */

const NAMED = [
    [/\bmedi(a)?eval\b|\bmiddle ages\b/i, 1200],
    [/\brenaissance\b/i, 1500],
    [/\bregency\b/i, 1811],
    [/\bvictorian\b/i, 1837],
    [/\bedwardian\b/i, 1901],
    [/\b(first world war|world war (one|i)|ww ?(1|i))\b/i, 1914],
    [/\b(roaring twenties|prohibition|jazz age)\b/i, 1920],
    [/\b(second world war|world war (two|ii)|ww ?(2|ii))\b/i, 1939],
];

/** The earliest year a period text implies, or null when it names no year ("Remnant", "a fantasy kingdom"). */
export function periodYear(text) {
    const t = String(text ?? '');
    const full = /(?<!\d)([12]\d{3})(?!\d)/.exec(t);

    if (full) {
        return Number(full[1]);
    }

    // "the 90s", "'80s": 00s and 10s are this century, the rest the last one.
    const decade = /(?<![\d])['’]?(\d0)s\b/i.exec(t);

    if (decade) {
        const d = Number(decade[1]);
        return (d <= 10 ? 2000 : 1900) + d;
    }

    const century = /\b(\d{1,2})(?:st|nd|rd|th)[ -]century\b/i.exec(t);

    if (century) {
        return (Number(century[1]) - 1) * 100;
    }

    for (const [pattern, year] of NAMED) {
        if (pattern.test(t)) {
            return year;
        }
    }

    return null;
}

/** A calendar year written in a state comment's time line ("Tuesday 14 June 1994, 21:40"), or null. */
export function yearFromClock(timeText) {
    const m = /(?<![\d:.])(1[5-9]\d{2}|2[01]\d{2})(?![\d:]|\s*(?:hours|hrs|h)\b)/i.exec(String(timeText ?? ''));
    return m ? Number(m[1]) : null;
}

/**
 * The period in force for a chat: what was typed for it, else the year on the story's own clock,
 * else none. `setting` of "off" turns the lock off even when the clock shows a year.
 * Returns { text, year, source: 'set' | 'clock' } or null.
 */
export function resolvePeriod({ setting, clock }) {
    const text = String(setting ?? '').trim();

    if (/^(off|none|no)$/i.test(text)) {
        return null;
    }

    if (text) {
        return { text, year: periodYear(text), source: 'set' };
    }

    const year = yearFromClock(clock);
    return year ? { text: String(year), year, source: 'clock' } : null;
}
