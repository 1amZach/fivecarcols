// Reads the ids out of carcols.meta and carvariations.meta without building a
// tree, keeping the offset of every number so it can be changed in place.
//
// carcols.meta        <Sirens|Lights|Kits><Item><id value="N"/>, and <kitName>N_name</kitName> for kits
// carvariations.meta  <kits><Item>N_name</Item></kits>, <sirenSettings value="N"/>, <lightSettings value="N"/>

export type Pool = 'siren' | 'light' | 'kit';

export interface Span {
    start: number;
    end: number;
}

export interface Def {
    pool: Pool;
    id: number;
    at: Span; // the digits of the id value
    line: number;
    name?: string; // kitName for kits, <name> for sirens
    prefix?: Span; // the N in a kitName of N_name
}

export interface Ref {
    pool: Pool;
    id: number; // NaN for a kit name without a number in front
    at: Span | null;
    line: number;
    kit?: string;
}

export interface Parsed {
    defs: Def[];
    refs: Ref[];
}

const blocks: Record<string, Pool> = { sirens: 'siren', lights: 'light', kits: 'kit' };
const refTags: Record<string, Pool> = { sirensettings: 'siren', lightsettings: 'light' };

const tagRe = /<(\/?)([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
const valueRe = /\bvalue\s*=\s*(["'])\s*(-?\d+)\s*\1/d;

// Comments become spaces so commented out entries are skipped and offsets stay put.
const blank = (text: string) => text.replace(/<!--[\s\S]*?(?:-->|$)/g, (m) => m.replace(/[^\r\n]/g, ' '));

export function lines(text: string) {
    const starts = [0];
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
    return (pos: number) => {
        let lo = 0, hi = starts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (starts[mid]! <= pos) lo = mid;
            else hi = mid - 1;
        }
        return lo + 1;
    };
}

// The trimmed text after an opening tag, and where it starts.
function textAfter(src: string, from: number) {
    const end = src.indexOf('<', from);
    const raw = src.slice(from, end === -1 ? src.length : end);
    const lead = raw.length - raw.trimStart().length;
    return { text: raw.trim(), start: from + lead };
}

function value(attrs: string, attrsAt: number) {
    const m = valueRe.exec(attrs);
    if (!m) return null;
    const [s, e] = m.indices![2]!;
    return { id: Number(m[2]), at: { start: attrsAt + s, end: attrsAt + e } };
}

export function parse(text: string): Parsed {
    const src = blank(text);
    const lineOf = lines(text);
    const defs: Def[] = [];
    const refs: Ref[] = [];
    const stack: string[] = [];
    let cur: Partial<Def> | null = null;

    tagRe.lastIndex = 0;
    for (let m: RegExpExecArray | null; (m = tagRe.exec(src)); ) {
        const [whole, close, rawName, attrs, self] = m;
        const name = rawName!.toLowerCase();
        const attrsAt = m.index + 1 + rawName!.length;
        const end = m.index + whole.length;

        if (close) {
            const i = stack.lastIndexOf(name);
            if (i === -1) continue;
            stack.length = i;
            if (cur && stack.length === 2) {
                if (cur.at) defs.push(cur as Def);
                cur = null;
            }
            continue;
        }

        const depth = stack.length;
        const parent = stack[depth - 1];

        if (depth === 2 && name === 'item' && !self && blocks[parent!]) {
            cur = { pool: blocks[parent!] };
        } else if (cur && depth === 3) {
            if (name === 'id') {
                const v = value(attrs!, attrsAt);
                if (v && !cur.at) Object.assign(cur, v, { line: lineOf(v.at.start) });
            } else if (name === 'kitname' && cur.pool === 'kit' && !self) {
                const t = textAfter(src, end);
                cur.name = t.text;
                const p = t.text.match(/^\d+(?=_)/);
                if (p) cur.prefix = { start: t.start, end: t.start + p[0].length };
            } else if (name === 'name' && cur.pool === 'siren' && !self) {
                cur.name = textAfter(src, end).text;
            }
        }

        if (refTags[name]) {
            const v = value(attrs!, attrsAt);
            if (v) refs.push({ pool: refTags[name]!, ...v, line: lineOf(v.at.start) });
        } else if (name === 'item' && parent === 'kits' && depth >= 3 && !self) {
            const t = textAfter(src, end);
            const p = t.text.match(/^\d+(?=_)/);
            if (t.text) {
                refs.push({
                    pool: 'kit',
                    kit: t.text,
                    id: p ? Number(p[0]) : NaN,
                    at: p ? { start: t.start, end: t.start + p[0].length } : null,
                    line: lineOf(t.start),
                });
            }
        }

        if (!self) stack.push(name);
    }
    return { defs, refs };
}
