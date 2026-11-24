import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url));
const { periodYear, yearFromClock, resolvePeriod } = await import(pathToFileURL(`${dir}/period.js`));
const { KINDS, kindsFor, holdToPeriod, systemPrompt, summary, plainText } = await import(pathToFileURL(`${dir}/documents.js`));

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ', name); };

t('years from period text', () => {
    assert.equal(periodYear('1994, Tokyo'), 1994);
    assert.equal(periodYear('the 1990s'), 1990);
    assert.equal(periodYear('the 90s'), 1990);
    assert.equal(periodYear("'80s Miami"), 1980);
    assert.equal(periodYear('the 10s'), 2010);
    assert.equal(periodYear('19th century Paris'), 1800);
    assert.equal(periodYear('Victorian London'), 1837);
    assert.equal(periodYear('Remnant'), null);
    assert.equal(periodYear(''), null);
});

t('year from the clock, not from a time of day', () => {
    assert.equal(yearFromClock('Tuesday 14 June 1994, 21:40'), 1994);
    assert.equal(yearFromClock('1994-06-14 21:40'), 1994);
    assert.equal(yearFromClock('2300 hours, Friday'), null);
    assert.equal(yearFromClock('Friday evening'), null);
    assert.equal(yearFromClock('21:40'), null);
    assert.equal(yearFromClock(null), null);
});

t('resolve: typed wins, blank reads the clock, off is off', () => {
    assert.deepEqual(resolvePeriod({ setting: 'the 90s', clock: '3 May 2024' }), { text: 'the 90s', year: 1990, source: 'set' });
    assert.deepEqual(resolvePeriod({ setting: '', clock: '3 May 1994, noon' }), { text: '1994', year: 1994, source: 'clock' });
    assert.equal(resolvePeriod({ setting: 'off', clock: '3 May 1994' }), null);
    assert.equal(resolvePeriod({ setting: '', clock: 'Friday evening' }), null);
    assert.equal(resolvePeriod({ setting: 'Remnant', clock: null }).year, null);
});

t('kinds by year', () => {
    const k94 = kindsFor(1994);
    assert.ok(!('text' in k94));
    assert.equal(k94.voicemail.label, 'Answering machine');
    assert.ok(!/phone|screen|site/i.test(k94.article.guide + k94.article.found + k94.broadcast.found));
    assert.ok(!('eras' in k94.article) && !('until' in k94.article));
    assert.ok('text' in kindsFor(2005) && kindsFor(2005).voicemail.label === 'Voicemail');
    assert.deepEqual(Object.keys(kindsFor(1890)).sort(), ['article', 'diary', 'file', 'letter', 'note', 'poster']);
    assert.equal(kindsFor(1935).broadcast.label, 'Radio');
    assert.equal(Object.keys(kindsFor(null)).length, Object.keys(KINDS).length);
    assert.equal(Object.keys(kindsFor(undefined)).length, Object.keys(KINDS).length);
});

t('1994 prompt offers no text kind and no phones', () => {
    const p = systemPrompt({ mode: 'dispatch', n: 2, userName: 'Usagi', period: { text: '1994, Tokyo', year: 1994 } });
    assert.ok(p.includes('Period lock: the story is set in 1994, Tokyo.'));
    assert.ok(!/^- text:/m.test(p));
    assert.ok(/^- voicemail: A transcript of one message left on a home or office answering machine/m.test(p));
    const offending = p.split('\n').filter(l => /text message|phone buzzing|notification|a phone playing|news-site|what a phone received/i.test(l));
    assert.deepEqual(offending, []);
});

t('no period: prompt unchanged apart from the neutral opening', () => {
    const p = systemPrompt({ mode: 'dispatch', n: 1, userName: 'A' });
    assert.ok(!p.includes('Period lock'));
    assert.ok(/^- text:/m.test(p));
});

t('period with no year: rule present, all kinds kept', () => {
    const p = systemPrompt({ mode: 'artefact', n: 1, userName: 'A', period: { text: 'Remnant', year: null } });
    assert.ok(p.includes('set in Remnant') && p.includes('does not exist in this period'));
    assert.ok(/^- text:/m.test(p));
});

t('holdToPeriod drops and relabels', () => {
    const docs = [
        { kind: 'text', source: 'Naru', title: '', body: 'x' },
        { kind: 'voicemail', source: 'Voicemail', title: 'Mum', from: 'Mum', body: 'x' },
        { kind: 'article', source: 'Asahi', title: 'T', body: 'x' },
    ];
    const { kept, dropped } = holdToPeriod(docs, { text: '1994', year: 1994 });
    assert.deepEqual(dropped.map(d => d.kind), ['text']);
    assert.equal(kept[0].label, 'Answering machine');
    assert.equal(kept[0].source, 'Answering machine');
    assert.equal(summary(kept[0]), 'Answering machine: Mum');
    assert.ok(plainText(kept[0]).startsWith('[Answering machine]'));
    assert.equal(kept[1].label, undefined);
    assert.equal(holdToPeriod(docs, null).dropped.length, 0);
});

console.log(`\n${n} passed`);
