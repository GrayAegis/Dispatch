import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url));
const { recall, plainText } = await import(pathToFileURL(`${dir}/documents.js`));

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ', name); };

// Newest first, as the store keeps them.
const items = [
    { id: 'c', kind: 'note', source: 'Naru', title: 'Under the door', keys: ['Naru', 'Crown Arcade'], body: 'Meet me at the Crown Arcade. N.' },
    { id: 'b', kind: 'article', source: 'Asahi Shimbun', title: 'Jewellery shop robbed', keys: ['Osa-P', 'Juban', 'Naru'], body: 'Police in Juban say the Osa-P jewellery shop was robbed overnight.' },
    { id: 'a', kind: 'file', source: 'Metropolitan Police', title: 'Case 114', keys: ['Tuxedo Mask', 'Juban Precinct'], body: 'Subject seen leaving by the roof.' },
];

t('matches on keys, whole words, any case', () => {
    assert.deepEqual(recall({ items, text: 'What happened at osa-p last night?', budgetChars: 5000 }).map(i => i.id), ['b']);
    assert.deepEqual(recall({ items, text: 'Nothing relevant here.', budgetChars: 5000 }), []);
    assert.deepEqual(recall({ items, text: 'The Narutaki bridge', budgetChars: 5000 }), []);
});

t('most keys matched first, then newest', () => {
    assert.deepEqual(recall({ items, text: 'Naru was in Juban near Osa-P.', budgetChars: 5000 }).map(i => i.id), ['b', 'c']);
    assert.deepEqual(recall({ items, text: 'Naru called.', budgetChars: 5000 }).map(i => i.id), ['c', 'b']);
});

t('budget: skips what does not fit, takes what does', () => {
    const small = plainText(items[0]).length;
    assert.deepEqual(recall({ items, text: 'Naru was in Juban near Osa-P.', budgetChars: small }).map(i => i.id), ['c']);
    assert.deepEqual(recall({ items, text: 'Naru', budgetChars: 5 }), []);
});

t('the user name is never a key', () => {
    const mine = [{ id: 'x', kind: 'note', source: 'Rei', title: 't', keys: ['Usagi', 'Hikawa Shrine'], body: 'b' }];
    assert.deepEqual(recall({ items: mine, text: 'Usagi yawned.', budgetChars: 5000, exclude: ['Usagi'] }), []);
    assert.equal(recall({ items: mine, text: 'At Hikawa Shrine.', budgetChars: 5000, exclude: ['Usagi'] }).length, 1);
});

t('keys with regex characters do not break matching', () => {
    const odd = [{ id: 'y', kind: 'note', source: 's', title: 't', keys: ['C.C. (club)', 'Dr. Tomoe'], body: 'b' }];
    assert.equal(recall({ items: odd, text: 'She saw Dr. Tomoe.', budgetChars: 5000 }).length, 1);
});

console.log(`\n${n} passed`);
