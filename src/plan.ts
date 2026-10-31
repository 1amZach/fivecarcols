import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { cmp, type MetaFile } from './find';
import type { Def, Pool, Span } from './meta';

export const pools: Pool[] = ['siren', 'light', 'kit'];

export interface Options {
    pools: Pool[];
    max: Record<Pool, number>;
    reserved: Record<Pool, Set<number>>;
}

// One side of a clash: everything that moves together. For sirens and lights
// that's every entry with the id in one resource, for kits every entry with the
// same kitName, since that's the same kit streamed from more than one place.
export interface Claim {
    pool: Pool;
    id: number;
    resource: string;
    name?: string;
    defs: { file: MetaFile; def: Def }[];
    ignored: boolean;
}

export interface Clash {
    pool: Pool;
    id: number;
    claims: Claim[]; // the first keeps its id
    reserved: boolean;
}

export interface Edit {
    file: MetaFile;
    at: Span;
    from: string;
    to: string;
}

export interface Move {
    pool: Pool;
    from: number;
    to: number;
    claim: Claim;
    name?: string; // new kitName
    edits: Edit[];
    refs: Edit[]; // carvariations lines
}

export interface Plan {
    files: MetaFile[];
    clashes: Clash[];
    moves: Move[];
    warnings: string[];
    key: string; // changes when the files or the plan change
}

const where = (f: MetaFile, line: number) => `${f.resource}/${f.path}:${line}`;

function claims(files: MetaFile[], pool: Pool) {
    const byId = new Map<number, Map<string, Claim>>();
    for (const file of files) {
        for (const def of file.parsed.defs) {
            if (def.pool !== pool) continue;
            const group = byId.get(def.id) ?? new Map<string, Claim>();
            byId.set(def.id, group);
            const k = pool === 'kit' && def.name ? 'kit:' + def.name.toLowerCase() : 'res:' + file.resource;
            let c = group.get(k);
            if (!c) group.set(k, (c = { pool, id: def.id, resource: file.resource, name: def.name, defs: [], ignored: false }));
            c.defs.push({ file, def });
            c.ignored ||= file.ignored;
        }
    }
    return byId;
}

// Ignored resources keep their ids, then whichever resource sorts first by
// name, then file path, then position in the file.
function order(a: Claim, b: Claim) {
    if (a.ignored !== b.ignored) return a.ignored ? -1 : 1;
    const x = a.defs[0]!, y = b.defs[0]!;
    return cmp(x.file.resource, y.file.resource) || cmp(x.file.path, y.file.path) || x.def.at.start - y.def.at.start;
}

const depth = (a: string, b: string) => {
    const x = a.split(/[\\/]/), y = b.split(/[\\/]/);
    let i = 0;
    while (i < x.length && i < y.length && x[i] === y[i]) i++;
    return i;
};

// Which side a <sirenSettings>/<lightSettings> number means. Its own resource if
// that defines the id, otherwise the one sitting closest in the folder tree.
function owner(file: MetaFile, claims: Claim[]): Claim | 'unsure' | null {
    if (!claims.length) return null;
    const own = claims.find((c) => c.resource === file.resource);
    if (own) return own;
    const here = dirname(file.abs);
    const scored = claims.map((c) => ({ c, d: Math.max(...c.defs.map((d) => depth(here, dirname(d.file.abs)))) })).sort((a, b) => b.d - a.d);
    if (scored.length > 1 && scored[0]!.d === scored[1]!.d) return 'unsure';
    return scored[0]!.c;
}

export function plan(files: MetaFile[], opts: Options): Plan {
    const clashes: Clash[] = [];
    const moves: Move[] = [];
    const warnings: string[] = [];
    const kitNames = new Set<string>();
    for (const f of files) for (const d of f.parsed.defs) if (d.pool === 'kit' && d.name) kitNames.add(d.name.toLowerCase());

    for (const pool of pools) {
        const byId = claims(files, pool);
        const max = opts.max[pool];
        const used = new Set<number>([0, ...opts.reserved[pool]]);
        if (pool === 'siren' && max > 254) used.add(255); // SSLA keeps 255 for itself
        // the top of a pool often means "none" to the game, so new ids never take it
        if (pool !== 'siren') used.add(max);
        for (const id of byId.keys()) used.add(id);
        for (const f of files) for (const r of f.parsed.refs) if (r.pool === pool && !Number.isNaN(r.id)) used.add(r.id);
        const free = () => {
            for (let i = max; i >= 1; i--) if (!used.has(i)) return used.add(i), i;
            return null;
        };

        const list = [...byId.entries()].filter(([id, g]) => id > 0 && g.size > 1).sort((a, b) => a[0] - b[0]);
        if (!opts.pools.includes(pool)) {
            for (const [id, g] of list) clashes.push({ pool, id, claims: [...g.values()].sort(order), reserved: false });
            continue;
        }

        const moved = new Map<Claim, Move>();
        for (const [id, g] of list) {
            const sorted = [...g.values()].sort(order);
            const clash = { pool, id, claims: sorted, reserved: opts.reserved[pool].has(id) };
            clashes.push(clash);
            if (clash.reserved) continue;
            for (const claim of sorted.slice(1)) {
                if (claim.ignored) continue;
                const to = free();
                if (to === null) {
                    warnings.push(`no free ${pool} id left for ${claim.resource} (${id}), raise the limit or free some up`);
                    continue;
                }
                const m: Move = { pool, from: id, to, claim, edits: [], refs: [] };
                for (const { file, def } of claim.defs) m.edits.push({ file, at: def.at, from: String(id), to: String(to) });
                moved.set(claim, m);
                moves.push(m);
            }
        }
        if (!moved.size) continue;

        if (pool === 'kit') {
            for (const m of moved.values()) {
                const name = m.claim.name;
                const lead = name?.match(/^\d+(?=_)/)?.[0];
                if (!name || !lead) continue;
                const next = m.to + name.slice(lead.length);
                if (kitNames.has(next.toLowerCase())) {
                    warnings.push(`kit ${name} gets id ${m.to}, but ${next} is taken so its name stays`);
                    continue;
                }
                kitNames.add(next.toLowerCase());
                m.name = next;
                for (const { file, def } of m.claim.defs) if (def.prefix) m.edits.push({ file, at: def.prefix, from: lead, to: String(m.to) });
                for (const f of files) {
                    for (const r of f.parsed.refs) {
                        if (r.pool !== 'kit' || !r.at || r.kit!.toLowerCase() !== name.toLowerCase()) continue;
                        if (f.ignored) warnings.push(`${where(f, r.line)} uses kit ${name} but is ignored, change it to ${next} by hand`);
                        else m.refs.push({ file: f, at: r.at, from: lead, to: String(m.to) });
                    }
                }
            }
            continue;
        }

        for (const f of files) {
            for (const r of f.parsed.refs) {
                if (r.pool !== pool) continue;
                const g = byId.get(r.id);
                if (!g || g.size < 2) continue;
                const o = owner(f, [...g.values()]);
                const m = o && o !== 'unsure' ? moved.get(o) : undefined;
                if (o === 'unsure') {
                    if ([...g.values()].some((c) => moved.has(c))) warnings.push(`${where(f, r.line)} uses ${pool} ${r.id}, which more than one other resource defines, so it's left as is. Check which one it should be`);
                } else if (m && f.ignored) {
                    warnings.push(`${where(f, r.line)} uses ${pool} ${r.id} from ${m.claim.resource} but is ignored, change it to ${m.to} by hand`);
                } else if (m) {
                    m.refs.push({ file: f, at: r.at!, from: String(r.id), to: String(m.to) });
                }
            }
        }
    }

    const h = createHash('sha256');
    for (const f of files) h.update(f.abs + '\0' + f.text.length + '\0' + createHash('sha1').update(f.text, 'latin1').digest('hex'));
    for (const m of moves) for (const e of [...m.edits, ...m.refs]) h.update(`${e.file.abs}:${e.at.start}:${e.to}`);
    return { files, clashes, moves, warnings, key: h.digest('hex') };
}

export const edits = (p: Plan) => p.moves.flatMap((m) => [...m.edits, ...m.refs]);

// The new contents of every file the plan changes.
export function render(p: Plan): Map<MetaFile, string> {
    const byFile = new Map<MetaFile, Edit[]>();
    for (const e of edits(p)) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
    const out = new Map<MetaFile, string>();
    for (const [file, list] of byFile) {
        list.sort((a, b) => b.at.start - a.at.start);
        let text = file.text;
        let last = Infinity;
        for (const e of list) {
            if (e.at.end > last) throw new Error(`overlapping changes in ${file.resource}/${file.path}`);
            if (text.slice(e.at.start, e.at.end) !== e.from) throw new Error(`${file.resource}/${file.path} doesn't look like it did when it was read`);
            text = text.slice(0, e.at.start) + e.to + text.slice(e.at.end);
            last = e.at.start;
        }
        out.set(file, text);
    }
    return out;
}

// The line an edit is on, before and after.
export function lineOf(e: Edit) {
    const t = e.file.text;
    const s = t.lastIndexOf('\n', e.at.start - 1) + 1;
    let n = t.indexOf('\n', e.at.end);
    if (n === -1) n = t.length;
    const before = t.slice(s, n).replace(/\r$/, '');
    const cut = e.at.start - s;
    return { before: before.trim(), after: (before.slice(0, cut) + e.to + before.slice(cut + e.from.length)).trim() };
}
