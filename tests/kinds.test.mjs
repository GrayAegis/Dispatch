import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url));
const d = await import(pathToFileURL(`${dir}/documents.js`));
const { KINDS, KIND_KEYS, availableKinds, earlierDocuments, holdToKinds, kindKey, kindLabel, parseDocuments, plainText, summary, systemPrompt, userPrompt } = d;

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ', name); };

const scroll = { key: 'scroll_message', label: 'Scroll message', guide: 'A message on a Scroll: sender and three to six short lines.', found: 'the Scroll chiming', look: 'text' };
const notice = { key: 'guild_notice', label: 'Guild notice', guide: '', found: '', look: 'nonsense' };

t('kind keys: slugged, unique, never a built-in', () => {
    assert.equal(kindKey('Scroll message'), 'scroll_message');
    assert.equal(kindKey('Note'), 'note_2');
    assert.equal(kindKey('Scroll message', ['scroll_message']), 'scroll_message_2');
    assert.equal(kindKey('  ¡¡¡  '), 'kind');
});

t('available kinds: off, on, period, custom', () => {
    const all = availableKinds();
    assert.deepEqual(Object.keys(all), KIND_KEYS);
    const remnant = availableKinds({ off: ['text', 'voicemail'], on: ['scroll_message'], custom: [scroll, notice] });
    assert.ok(!remnant.text && !remnant.voicemail && remnant.article);
    assert.equal(remnant.scroll_message.label, 'Scroll message');
    assert.equal(remnant.scroll_message.look, 'text');
    assert.ok(!remnant.guild_notice, 'a custom kind is off until switched on');
    const y1994 = availableKinds({ year: 1994, on: ['scroll_message', 'guild_notice'], custom: [scroll, notice] });
    assert.ok(!y1994.text && y1994.scroll_message, 'the period removes text but not a custom kind');
    assert.equal(y1994.guild_notice.look, 'plain');
    assert.ok(y1994.guild_notice.guide.includes('Guild notice') && y1994.guild_notice.found);
    assert.ok(!availableKinds({ on: ['note'], custom: [{ key: 'note', label: 'Fake' }] }).note.custom, 'a custom kind cannot replace a built-in');
});

t('prompt lists custom kinds and omits switched-off ones', () => {
    const kinds = availableKinds({ off: ['text'], on: ['scroll_message'], custom: [scroll] });
    const p = systemPrompt({ mode: 'dispatch', n: 1, userName: 'Jaune', kinds });
    assert.ok(/^- scroll_message: A message on a Scroll.*Where found: the Scroll chiming\.$/m.test(p));
    assert.ok(!/^- text:/m.test(p));
    assert.ok(p.includes('Documents listed as earlier documents already exist'));
});

t('parse accepts a custom kind key; unknown kinds become notes', () => {
    const answer = JSON.stringify([{ kind: 'scroll_message', source: 'Ruby', body: 'where r u' }, { kind: 'hologram', body: 'x' }]);
    assert.deepEqual(parseDocuments(answer, ['scroll_message', 'note']).map(x => x.kind), ['scroll_message', 'note']);
    assert.deepEqual(parseDocuments(answer).map(x => x.kind), ['note', 'note']);
    const bare = parseDocuments(JSON.stringify([{ kind: 'scroll_message', body: 'x' }]), ['scroll_message']);
    assert.equal(bare[0].source, 'scroll_message');
});

t('holdToKinds: custom documents carry label, icon and look; switched-off kinds drop', () => {
    const kinds = availableKinds({ off: ['text'], on: ['scroll_message'], custom: [scroll] });
    const docs = parseDocuments(JSON.stringify([{ kind: 'scroll_message', body: 'x' }, { kind: 'text', source: 'A', body: 'y' }, { kind: 'letter', source: 'B', body: 'z' }]), Object.keys(kinds));
    const { kept, dropped } = holdToKinds(docs, kinds);
    assert.deepEqual(dropped.map(x => x.kind), ['text']);
    assert.equal(kept[0].label, 'Scroll message');
    assert.equal(kept[0].look, 'text');
    assert.equal(kept[0].source, 'Scroll message');
    assert.equal(kindLabel(kept[0]), 'Scroll message');
    assert.ok(plainText(kept[0]).startsWith('[Scroll message]'));
    assert.equal(kept[1].label, undefined);
    assert.equal(summary({ kind: 'gone_kind', label: 'Old kind', source: 'S', title: '' }), 'Old kind: S');
});

t('earlier documents: oldest to newest, limited, gist trimmed', () => {
    const items = [
        { kind: 'article', source: 'Vale Courier', date: '3 May', title: 'Second robbery', from: 'Lisa Lavender', body: 'A second dust shop was robbed. '.repeat(30) },
        { kind: 'letter', source: 'Ozpin', date: '2 May', title: '', from: 'Ozpin', to: 'Qrow', body: 'Come at once.' },
        { kind: 'article', source: 'Vale Courier', date: '1 May', title: 'Dust shop robbed', body: 'First.' },
    ];
    const text = earlierDocuments(items, { limit: 2, gistChars: 60 });
    const lines = text.split('\n');
    assert.equal(lines.length, 2);
    assert.ok(lines[0].startsWith('- [Letter] Ozpin, 2 May (by Ozpin, to Qrow): Come at once.'));
    assert.ok(lines[1].startsWith('- [News article] Vale Courier, 3 May — "Second robbery" (by Lisa Lavender): A second dust shop'));
    assert.ok(lines[1].endsWith('…') && lines[1].length < 160);
    assert.equal(earlierDocuments([], {}), '');
    assert.equal(earlierDocuments(items, { limit: 0 }), '');
});

t('user prompt carries the earlier documents between reference and story', () => {
    const p = userPrompt({ reference: 'R', story: 'S', request: 'Q', earlier: '- one' });
    assert.ok(p.indexOf('<reference>') < p.indexOf('<earlier_documents>') && p.indexOf('<earlier_documents>') < p.indexOf('<story_so_far>'));
    assert.ok(!userPrompt({ reference: 'R', story: 'S', request: 'Q' }).includes('earlier_documents'));
});

t('truncated answers are still salvaged', () => {
    const cut = '[{"kind":"note","source":"A","body":"one"},{"kind":"note","source":"B","body":"tw';
    assert.equal(parseDocuments(cut).length, 1);
});

console.log(`\n${n} passed`);
