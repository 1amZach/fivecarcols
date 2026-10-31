import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isMeta } from '../src/find';
import { parse } from '../src/meta';
import { carcols, carvariations, kit, light, siren, vehicle } from './helpers';

test('reads top level ids of each pool', () => {
    const text = carcols({ sirens: [siren(12, 'police')], lights: [light(40)], kits: [kit(512, '512_pack_modkit')] });
    const { defs } = parse(text);
    assert.deepEqual(defs.map((d) => [d.pool, d.id, d.name]), [['kit', 512, '512_pack_modkit'], ['light', 40, undefined], ['siren', 12, 'police']]);
    for (const d of defs) assert.equal(text.slice(d.at.start, d.at.end), String(d.id));
    const k = defs[0]!;
    assert.equal(text.slice(k.prefix!.start, k.prefix!.end), '512');
});

test('nested items and other values are not ids', () => {
    const { defs } = parse(carcols({ sirens: [siren(3)], kits: [kit(7, '7_x')] }));
    assert.equal(defs.length, 2); // the <Item>s inside <sirens> and <visibleMods> don't count
});

test('commented out entries are skipped', () => {
    const text = carcols({ sirens: [siren(3), `\n    <!-- old one\n${siren(4)}\n    -->`] });
    assert.deepEqual(parse(text).defs.map((d) => d.id), [3]);
    assert.deepEqual(parse('<a><kits><Item><!-- 5_x --></Item></kits></a>').refs, []);
});

test('reads carvariations references', () => {
    const text = carvariations([vehicle('a', { kits: ['512_pack_modkit', 'plainkit'], siren: 12, light: 40 })]);
    const refs = parse(text).refs;
    assert.deepEqual(refs.map((r) => [r.pool, r.id, r.kit]), [['kit', 512, '512_pack_modkit'], ['kit', NaN, 'plainkit'], ['light', 40, undefined], ['siren', 12, undefined]]);
    assert.equal(refs[1]!.at, null);
    for (const r of [refs[0]!, refs[2]!, refs[3]!]) assert.equal(text.slice(r.at!.start, r.at!.end), String(r.id));
    assert.equal(parse(text).defs.length, 0);
});

test('odd but valid markup', () => {
    const text = `<CVehicleModelInfoVarGlobal>\r\n<Sirens><Item><id value='9'></id></Item><Item><id  value = " 10 "/></Item></Sirens><Lights/>\r\n</CVehicleModelInfoVarGlobal>`;
    assert.deepEqual(parse(text).defs.map((d) => [d.id, d.line]), [[9, 2], [10, 2]]);
});

test('lines are counted from the original text', () => {
    const text = carcols({ lights: [light(1), light(2)] });
    const defs = parse(text).defs;
    for (const d of defs) assert.match(text.split('\n')[d.line - 1]!, new RegExp(`<id value="${d.id}"`));
});

test('meta file names', () => {
    for (const n of ['carcols.meta', 'CarCols.META', 'carvariations.meta', 'police_carcols.meta', 'carvariations_pd.meta'])
        assert.ok(isMeta(n), n);
    for (const n of ['vehicles.meta', 'carcols.meta.bak', 'handling.meta', 'carcols.xml']) assert.ok(!isMeta(n), n);
});
