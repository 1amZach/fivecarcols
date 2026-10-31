import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { apply, history, prune, target, undo, type Write } from '../src/apply';
import { max, parse as parseConfig, reserved } from '../src/config';
import { ignores, load } from '../src/find';
import { plan, render, type Plan } from '../src/plan';
import { carcols, carvariations, kit, light, opts, planFor, server, siren, vehicle } from './helpers';

const moves = (p: Plan) => p.moves.map((m) => `${m.pool} ${m.claim.resource} ${m.from}->${m.to}`);

function writesOf(p: Plan): Write[] {
    return [...render(p)].map(([f, text]) => ({ resource: f.resource, root: f.root, path: f.path, before: Buffer.from(f.text, 'latin1'), data: Buffer.from(text, 'latin1') }));
}

test('siren clash: the resource that sorts first keeps it, the other moves with its carvariations', async () => {
    const s = server({
        'bravo/data/carcols.meta': carcols({ sirens: [siren(12)] }),
        'bravo/data/carvariations.meta': carvariations([vehicle('b', { siren: 12, light: 1 })]),
        'alpha/carcols.meta': carcols({ sirens: [siren(12)] }),
        'alpha/carvariations.meta': carvariations([vehicle('a', { siren: 12 })]),
    });
    const p = await planFor(s.resources);
    assert.equal(p.clashes.length, 1);
    assert.deepEqual(p.clashes[0]!.claims.map((c) => c.resource), ['alpha', 'bravo']);
    assert.deepEqual(moves(p), ['siren bravo 12->254']);
    const out = new Map([...render(p)].map(([f, t]) => [`${f.resource}/${f.path}`, t]));
    assert.deepEqual([...out.keys()].sort(), ['bravo/data/carcols.meta', 'bravo/data/carvariations.meta']);
    assert.match(out.get('bravo/data/carvariations.meta')!, /<sirenSettings value="254" \/>/);
    assert.match(out.get('bravo/data/carvariations.meta')!, /<lightSettings value="1" \/>/);
});

test('light clash', async () => {
    const s = server({
        'a/carcols.meta': carcols({ lights: [light(30), light(31)] }),
        'b/carcols.meta': carcols({ lights: [light(31)] }),
        'b/carvariations.meta': carvariations([vehicle('b', { light: 31, siren: 31 })]),
    });
    const p = await planFor(s.resources);
    assert.deepEqual(moves(p), ['light b 31->255']);
    const cv = [...render(p)].find(([f]) => f.path === 'carvariations.meta')![1];
    assert.match(cv, /<lightSettings value="255" \/>/);
    assert.match(cv, /<sirenSettings value="31" \/>/); // the siren number isn't a light
});

test('three way clash gives each loser its own id', async () => {
    const s = server({
        'a/carcols.meta': carcols({ sirens: [siren(5)] }),
        'b/carcols.meta': carcols({ sirens: [siren(5)] }),
        'c/carcols.meta': carcols({ sirens: [siren(5)] }),
    });
    const p = await planFor(s.resources);
    assert.deepEqual(moves(p), ['siren b 5->254', 'siren c 5->253']);
});

test('kit clash renames the kitName and every carvariations line using it, in any resource', async () => {
    const s = server({
        '[cars]/pack_a/carcols.meta': carcols({ kits: [kit(500, '500_pack_a_modkit')] }),
        '[cars]/pack_a/carvariations.meta': carvariations([vehicle('a', { kits: ['500_pack_a_modkit'] })]),
        '[cars]/pack_b/stream/carcols.meta': carcols({ kits: [kit(500, '500_pack_b_modkit')] }),
        '[cars]/pack_b/stream/carvariations.meta': carvariations([vehicle('b', { kits: ['500_pack_b_modkit'] })]),
        // uses pack_b's kit without defining it
        '[other]/extra/carvariations.meta': carvariations([vehicle('c', { kits: ['500_PACK_B_MODKIT', '500_pack_a_modkit'] })]),
    });
    const p = await planFor(s.resources);
    assert.deepEqual(moves(p), ['kit pack_b 500->65535']);
    assert.equal(p.moves[0]!.name, '65535_pack_b_modkit');
    const out = new Map([...render(p)].map(([f, t]) => [`${f.resource}/${f.path}`, t]));
    assert.deepEqual([...out.keys()].sort(), ['extra/carvariations.meta', 'pack_b/stream/carcols.meta', 'pack_b/stream/carvariations.meta']);
    assert.match(out.get('pack_b/stream/carcols.meta')!, /<kitName>65535_pack_b_modkit<\/kitName>\s*<id value="65535" \/>/);
    assert.match(out.get('pack_b/stream/carvariations.meta')!, /<Item>65535_pack_b_modkit<\/Item>/);
    const extra = out.get('extra/carvariations.meta')!;
    assert.match(extra, /<Item>65535_PACK_B_MODKIT<\/Item>/);
    assert.match(extra, /<Item>500_pack_a_modkit<\/Item>/);
});

test('the same kit in more than one place is one kit, not a clash', async () => {
    const s = server({
        'a/carcols.meta': carcols({ kits: [kit(700, '700_shared')] }),
        'b/carcols.meta': carcols({ kits: [kit(700, '700_shared')] }),
        'c/carcols.meta': carcols({ kits: [kit(700, '700_other')] }),
    });
    const p = await planFor(s.resources);
    assert.equal(p.clashes[0]!.claims.length, 2);
    assert.deepEqual(moves(p), ['kit c 700->65535']);

    const t = server({
        'b/carcols.meta': carcols({ kits: [kit(700, '700_shared')] }),
        'c/carcols.meta': carcols({ kits: [kit(700, '700_shared')] }),
        'a/carcols.meta': carcols({ kits: [kit(700, '700_first')] }),
    });
    const q = await planFor(t.resources);
    // the shared kit moves as one, in both files
    assert.deepEqual(q.moves[0]!.claim.defs.map((d) => d.file.resource), ['b', 'c']);
    assert.equal(render(q).size, 2);
});

test('a kitName without a number in front keeps its name', async () => {
    const s = server({
        'a/carcols.meta': carcols({ kits: [kit(9, 'first')] }),
        'b/carcols.meta': carcols({ kits: [kit(9, 'second')] }),
        'b/carvariations.meta': carvariations([vehicle('b', { kits: ['second'] })]),
    });
    const p = await planFor(s.resources);
    assert.deepEqual(moves(p), ['kit b 9->65535']);
    assert.equal(p.moves[0]!.name, undefined);
    assert.equal(p.moves[0]!.refs.length, 0);
});

test('a new kitName that already exists stays unchanged and says so', async () => {
    const s = server({
        'a/carcols.meta': carcols({ kits: [kit(9, '9_x'), kit(1, '65535_x')] }),
        'b/carcols.meta': carcols({ kits: [kit(9, '9_x2')] }),
        'c/carcols.meta': carcols({ kits: [kit(9, '9_x')] }),
    });
    const p = await planFor(s.resources, { max: { siren: 254, light: 255, kit: 65535 } });
    assert.deepEqual(moves(p), ['kit b 9->65535']);
    assert.equal(p.moves[0]!.name, '65535_x2');
    const s2 = server({
        'a/carcols.meta': carcols({ kits: [kit(9, '9_x'), kit(1, '65535_y')] }),
        'b/carcols.meta': carcols({ kits: [kit(9, '9_y')] }),
    });
    const p2 = await planFor(s2.resources);
    assert.equal(p2.moves[0]!.name, undefined);
    assert.match(p2.warnings[0]!, /65535_y is taken/);
});

test('siren references in other resources follow the closest folder, or are left alone with a warning', async () => {
    const s = server({
        '[police]/lspd_sirens/carcols.meta': carcols({ sirens: [siren(20)] }),
        '[police]/lspd_car/carvariations.meta': carvariations([vehicle('police9', { siren: 20 })]),
        '[civ]/aaa_pack/carcols.meta': carcols({ sirens: [siren(20)] }),
        'loose/carvariations.meta': carvariations([vehicle('x', { siren: 20 })]),
    });
    const p = await planFor(s.resources);
    assert.deepEqual(moves(p), ['siren lspd_sirens 20->254']);
    const out = new Map([...render(p)].map(([f, t]) => [`${f.resource}/${f.path}`, t]));
    assert.match(out.get('lspd_car/carvariations.meta')!, /<sirenSettings value="254" \/>/);
    assert.ok(!out.has('loose/carvariations.meta'));
    assert.equal(p.warnings.length, 1);
    assert.match(p.warnings[0]!, /loose\/carvariations\.meta:\d+ uses siren 20/);
});

test('refs in the resource that keeps the id stay', async () => {
    const s = server({
        'a/carcols.meta': carcols({ sirens: [siren(3)] }),
        'a/carvariations.meta': carvariations([vehicle('a', { siren: 3 })]),
        'b/carcols.meta': carcols({ sirens: [siren(3)] }),
    });
    const p = await planFor(s.resources);
    assert.deepEqual([...render(p).keys()].map((f) => `${f.resource}/${f.path}`), ['b/carcols.meta']);
});

test('only the numbers change: CRLF, BOM, tabs and comments stay byte for byte', async () => {
    const bom = '﻿';
    const a = carcols({ sirens: [siren(8)] });
    const b = (bom + carcols({ sirens: [siren(8, 'ünïcode')], kits: [kit(64, '64_b_kit')] }).replace('<Kits>', '<Kits>\t<!-- <id value="64" /> keep me -->')).replace(/\n/g, '\r\n');
    const bv = (bom + carvariations([vehicle('b', { siren: 8, kits: ['64_b_kit'] })])).replace(/\n/g, '\r\n');
    const s = server({
        'a/carcols.meta': a,
        'a/carvariations.meta': carvariations([vehicle('a', { kits: ['64_a_kit'] })]),
        'aa/carcols.meta': carcols({ kits: [kit(64, '64_a_kit')] }),
        'b/carcols.meta': Buffer.from(b, 'utf8'),
        'b/carvariations.meta': Buffer.from(bv, 'utf8'),
    });
    const p = await planFor(s.resources);
    assert.deepEqual(moves(p).sort(), ['kit b 64->65535', 'siren b 8->254']);
    const f = await load(s.resources);
    const fv = f.find((x) => x.resource === 'b' && x.path === 'carvariations.meta')!;
    apply(join(s.dir, 'backups'), writesOf(p), []);

    const expect = Buffer.from(
        b.replace('<id value="8" />', '<id value="254" />').replace('<kitName>64_b_kit', '<kitName>65535_b_kit').replace('<id value="64" />\r\n      <kitType>', '<id value="65535" />\r\n      <kitType>'),
        'utf8',
    );
    assert.deepEqual(s.read('b/carcols.meta'), expect);
    assert.match(s.read('b/carcols.meta').toString('utf8'), /<!-- <id value="64" \/> keep me -->/);
    assert.deepEqual(s.read('b/carvariations.meta'), Buffer.from(bv.replace('value="8"', 'value="254"').replace('<Item>64_b_kit', '<Item>65535_b_kit'), 'utf8'));
    assert.deepEqual(s.read('a/carcols.meta'), Buffer.from(a));
    assert.ok(fv.text.startsWith('\xEF\xBB\xBF'));
});

test('nothing changes when there are no clashes', async () => {
    const s = server({
        'a/carcols.meta': carcols({ sirens: [siren(1)], lights: [light(1)], kits: [kit(1, '1_a'), kit(0, '0_default_modkit')] }),
        'b/carcols.meta': carcols({ sirens: [siren(2)], lights: [light(2)], kits: [kit(2, '2_b'), kit(0, '0_default_modkit')] }),
        'b/carvariations.meta': carvariations([vehicle('b', { siren: 2, light: 2, kits: ['2_b'] })]),
    });
    const p = await planFor(s.resources);
    assert.equal(p.clashes.length, 0);
    assert.equal(p.moves.length, 0);
    assert.equal(render(p).size, 0);
});

test('id 0 is never a clash', async () => {
    const s = server({
        'a/carcols.meta': carcols({ kits: [kit(0, '0_a')], sirens: [siren(0)] }),
        'b/carcols.meta': carcols({ kits: [kit(0, '0_b')], sirens: [siren(0)] }),
    });
    assert.equal((await planFor(s.resources)).clashes.length, 0);
});

test('new ids skip ids in use, used by carvariations only, and reserved', async () => {
    const s = server({
        'a/carcols.meta': carcols({ sirens: [siren(10), siren(254)] }),
        'b/carcols.meta': carcols({ sirens: [siren(10)] }),
        'c/carcols.meta': carcols({ sirens: [siren(10)] }),
        'c/carvariations.meta': carvariations([vehicle('c', { siren: 253 })]), // a siren not defined anywhere, probably the base game's
        'd/carcols.meta': carcols({ sirens: [siren(10)] }),
    });
    const p = await planFor(s.resources, { reserved: { siren: new Set([250, 251, 252]), light: new Set(), kit: new Set() } });
    assert.deepEqual(moves(p), ['siren b 10->249', 'siren c 10->248', 'siren d 10->247']);
    const all = new Set<number>();
    for (const f of p.files) for (const d of f.parsed.defs) all.add(d.id);
    for (const m of p.moves) assert.ok(!all.has(m.to));
});

test('reserved ids that clash are left alone', async () => {
    const s = server({
        'a/carcols.meta': carcols({ sirens: [siren(5)] }),
        'b/carcols.meta': carcols({ sirens: [siren(5)] }),
    });
    const p = await planFor(s.resources, { reserved: { siren: new Set([5]), light: new Set(), kit: new Set() } });
    assert.equal(p.clashes.length, 1);
    assert.ok(p.clashes[0]!.reserved);
    assert.equal(p.moves.length, 0);
});

test('SSLA range picks from the top and skips 255', async () => {
    const s = server({
        'a/carcols.meta': carcols({ sirens: [siren(300), siren(65534)] }),
        'b/carcols.meta': carcols({ sirens: [siren(300)] }),
    });
    const p = await planFor(s.resources, { max: { siren: 65534, light: 255, kit: 65535 } });
    assert.deepEqual(moves(p), ['siren b 300->65533']);
    const tiny = server({
        'a/carcols.meta': carcols({ sirens: [siren(1)] }),
        'b/carcols.meta': carcols({ sirens: [siren(1)] }),
    });
    const q = await planFor(tiny.resources, { max: { siren: 255, light: 255, kit: 65535 } });
    assert.deepEqual(moves(q), ['siren b 1->254']);
});

test('a full pool says so instead of reusing an id', async () => {
    const s = server({
        'a/carcols.meta': carcols({ lights: [light(1), light(2), light(3)] }),
        'b/carcols.meta': carcols({ lights: [light(3)] }),
    });
    const p = await planFor(s.resources, { max: { siren: 254, light: 3, kit: 65535 } });
    assert.equal(p.moves.length, 0);
    assert.match(p.warnings[0]!, /no free light id/);
});

test('pools turned off are reported but not fixed', async () => {
    const s = server({
        'a/carcols.meta': carcols({ sirens: [siren(5)], lights: [light(5)] }),
        'b/carcols.meta': carcols({ sirens: [siren(5)], lights: [light(5)] }),
    });
    const p = await planFor(s.resources, { pools: ['light', 'kit'] });
    assert.equal(p.clashes.length, 2);
    assert.deepEqual(moves(p), ['light b 5->255']);
});

test('ignored resources keep their ids and are never written', async () => {
    const s = server({
        'a/carcols.meta': carcols({ kits: [kit(40, '40_a')] }),
        'a/carvariations.meta': carvariations([vehicle('a', { kits: ['40_a'] })]),
        '[locked]/zz/carcols.meta': carcols({ kits: [kit(40, '40_zz')] }),
        '[locked]/zz/carvariations.meta': carvariations([vehicle('z', { kits: ['40_a'] })]),
    });
    const p = await planFor(s.resources, {}, ignores(['zz']));
    assert.deepEqual(moves(p), ['kit a 40->65535']);
    assert.ok([...render(p).keys()].every((f) => f.resource !== 'zz'));
    assert.match(p.warnings[0]!, /zz\/carvariations\.meta:\d+ uses kit 40_a but is ignored/);

    const q = await planFor(s.resources, {}, ignores(['[locked]']));
    assert.ok(q.files.find((f) => f.resource === 'zz')!.ignored);
    const both = await planFor(s.resources, {}, ignores(['a', 'zz']));
    assert.equal(both.moves.length, 0);
});

test('after a fix a new scan finds nothing', async () => {
    const s = server({
        'a/carcols.meta': carcols({ sirens: [siren(5)], lights: [light(5)], kits: [kit(5, '5_a')] }),
        'b/carcols.meta': carcols({ sirens: [siren(5)], lights: [light(5)], kits: [kit(5, '5_b')] }),
        'b/carvariations.meta': carvariations([vehicle('b', { siren: 5, light: 5, kits: ['5_b'] })]),
        'c/carcols.meta': carcols({ sirens: [siren(5)], lights: [light(5)], kits: [kit(5, '5_c')] }),
    });
    const p = await planFor(s.resources);
    assert.equal(p.moves.length, 6);
    apply(join(s.dir, 'backups'), writesOf(p), []);
    const again = await planFor(s.resources);
    assert.equal(again.clashes.length, 0);
    assert.match(s.text('b/carvariations.meta'), /<Item>65535_b<\/Item>/);
});

test('undo puts every file back exactly', async () => {
    const s = server({
        'a/carcols.meta': carcols({ sirens: [siren(5)] }),
        'b/carcols.meta': carcols({ sirens: [siren(5)] }).replace(/\n/g, '\r\n'),
        'b/carvariations.meta': carvariations([vehicle('b', { siren: 5 })]),
    });
    const before = { cc: s.read('b/carcols.meta'), cv: s.read('b/carvariations.meta') };
    const dir = join(s.dir, 'backups');
    const f = apply(dir, writesOf(await planFor(s.resources)), []);
    assert.notDeepEqual(s.read('b/carcols.meta'), before.cc);
    assert.equal(history(dir)[0]!.state, 'done');
    const u = undo(dir, history(dir)[0]!);
    assert.deepEqual(u.skipped, []);
    assert.deepEqual(s.read('b/carcols.meta'), before.cc);
    assert.deepEqual(s.read('b/carvariations.meta'), before.cv);
    assert.equal(history(dir)[0]!.state, 'undone');
    assert.equal(f.files.length, 2);
});

test('undo leaves a file alone that changed after the fix', async () => {
    const s = server({
        'a/carcols.meta': carcols({ sirens: [siren(5)] }),
        'b/carcols.meta': carcols({ sirens: [siren(5)] }),
        'b/carvariations.meta': carvariations([vehicle('b', { siren: 5 })]),
    });
    const dir = join(s.dir, 'backups');
    apply(dir, writesOf(await planFor(s.resources)), []);
    const edited = s.text('b/carvariations.meta') + '<!-- mine -->';
    writeFileSync(join(s.root, 'b/carvariations.meta'), edited);
    const u = undo(dir, history(dir)[0]!);
    assert.deepEqual(u.skipped, ['b/carvariations.meta']);
    assert.equal(s.text('b/carvariations.meta'), edited);
    assert.match(s.text('b/carcols.meta'), /<id value="5" \/>/);
});

test('a fix that crashed halfway is found and undone', async () => {
    const s = server({
        'a/carcols.meta': carcols({ sirens: [siren(5)] }),
        'b/carcols.meta': carcols({ sirens: [siren(5)] }),
        'b/carvariations.meta': carvariations([vehicle('b', { siren: 5 })]),
    });
    const dir = join(s.dir, 'backups');
    const original = s.read('b/carvariations.meta');
    const w = writesOf(await planFor(s.resources));
    const f = apply(dir, w, []);
    // as if it died after the first file: second one back to the original, record still says writing
    writeFileSync(join(s.root, w[1]!.path.startsWith('carvar') ? 'b/carvariations.meta' : 'b/carcols.meta'), w[1]!.before);
    const rec = join(dir, f.id, 'fix.json');
    writeFileSync(rec, JSON.stringify({ ...JSON.parse(readFileSync(rec, 'utf8')), state: 'writing' }));
    assert.equal(history(dir)[0]!.state, 'writing');
    const u = undo(dir, history(dir)[0]!);
    assert.deepEqual(u.skipped, []);
    assert.deepEqual(s.read('b/carvariations.meta'), original);
    assert.match(s.text('b/carcols.meta'), /<id value="5" \/>/);
});

test('apply refuses when a file changed since it was read', async () => {
    const s = server({
        'a/carcols.meta': carcols({ sirens: [siren(5)] }),
        'b/carcols.meta': carcols({ sirens: [siren(5)] }),
    });
    const w = writesOf(await planFor(s.resources));
    writeFileSync(join(s.root, 'b/carcols.meta'), carcols({ sirens: [siren(6)] }));
    assert.throws(() => apply(join(s.dir, 'backups'), w, []), /changed since/);
    assert.ok(!existsSync(join(s.dir, 'backups')));
});

test('never writes outside the resource folder', () => {
    const s = server({ 'a/carcols.meta': 'x', 'b/carcols.meta': 'y' });
    const a = join(s.root, 'a');
    assert.throws(() => target(a, '../b/carcols.meta'));
    assert.throws(() => target(a, join(s.root, 'b/carcols.meta')));
    assert.throws(() => target(a, ''));
    mkdirSync(join(s.dir, 'elsewhere'));
    symlinkSync(join(s.dir, 'elsewhere'), join(a, 'link'));
    assert.throws(() => target(a, 'link/carcols.meta'), /link/);
    symlinkSync(join(s.root, 'b/carcols.meta'), join(a, 'linked.meta'));
    assert.throws(() => target(a, 'linked.meta'), /link/);
    assert.equal(target(a, 'carcols.meta'), join(a, 'carcols.meta'));
});

test('finds meta files in subfolders and skips node_modules, .git, backups and links', async () => {
    const s = server({
        'a/fxmanifest.lua': '',
        'a/stream/cars/one/carcols.meta': carcols({}),
        'a/data/POLICE_carvariations.meta': carvariations([]),
        'a/node_modules/x/carcols.meta': carcols({}),
        'a/.git/carcols.meta': carcols({}),
        'a/backups/carcols.meta': carcols({}),
        'a/vehicles.meta': '',
        'b/fxmanifest.lua': '',
    });
    symlinkSync(join(s.root, 'a/stream'), join(s.root, 'b/stream'));
    const files = await load(s.resources);
    assert.deepEqual(files.map((f) => `${f.resource}/${f.path}`), ['a/data/POLICE_carvariations.meta', 'a/stream/cars/one/carcols.meta']);
});

test('a resource inside another is read once, as itself', async () => {
    const s = server({ 'outer/carcols.meta': carcols({}), 'outer/inner/carcols.meta': carcols({}) });
    const files = await load([...s.resources, { name: 'inner', root: join(s.root, 'outer/inner') }]);
    assert.deepEqual(files.map((f) => `${f.resource}/${f.path}`), ['inner/carcols.meta', 'outer/carcols.meta']);
});

test('backups are pruned to the newest few', async () => {
    const s = server({ 'a/carcols.meta': carcols({ sirens: [siren(5)] }), 'b/carcols.meta': carcols({ sirens: [siren(5)] }) });
    const dir = join(s.dir, 'backups');
    for (let i = 0; i < 3; i++) {
        apply(dir, writesOf(await planFor(s.resources)), []);
        undo(dir, history(dir)[0]!);
        await new Promise((r) => setTimeout(r, 3));
    }
    prune(dir, 2);
    assert.equal(history(dir).length, 2);
});

test('config', () => {
    const c = parseConfig('{"sirenMax": 65534, "pools": {"lights": false}, "reserved": {"kits": [3, "10-12", "bad"]}}');
    assert.equal(max(c, 'siren'), 65534);
    assert.equal(c.pools.sirens, true);
    assert.equal(c.pools.lights, false);
    assert.deepEqual([...reserved(c, 'kit')], [3, 10, 11, 12]);
    assert.equal(max(parseConfig(null), 'siren'), 254);
    assert.equal(max(parseConfig('{"sirenMax": 999999}'), 'siren'), 65534);
});

test('plan key changes when a file changes', async () => {
    const s = server({ 'a/carcols.meta': carcols({ sirens: [siren(5)] }), 'b/carcols.meta': carcols({ sirens: [siren(5)] }) });
    const one = plan(await load(s.resources), opts());
    const two = plan(await load(s.resources), opts());
    assert.equal(one.key, two.key);
    writeFileSync(join(s.root, 'b/carcols.meta'), carcols({ sirens: [siren(5), siren(6)] }));
    assert.notEqual(plan(await load(s.resources), opts()).key, one.key);
});

test('the same siren id twice in one resource moves together', async () => {
    const s = server({
        'a/carcols.meta': carcols({ sirens: [siren(7)] }),
        'b/cars/one/carcols.meta': carcols({ sirens: [siren(7)] }),
        'b/cars/two/carcols.meta': carcols({ sirens: [siren(7)] }),
        'b/cars/two/carvariations.meta': carvariations([vehicle('two', { siren: 7 })]),
    });
    const p = await planFor(s.resources);
    assert.deepEqual(moves(p), ['siren b 7->254']);
    assert.equal(render(p).size, 3);
});
