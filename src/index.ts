import { join } from 'node:path';
import { apply as write, history, prune, undo as putBack, type Fix } from './apply';
import { enabled, max, parse, reserved, type Config } from './config';
import { ignores, load, type MetaFile, type Resource } from './find';
import type { Pool } from './meta';
import { lineOf, plan, pools, render, type Claim, type Plan } from './plan';

const self = GetCurrentResourceName();
const backups = join(GetResourcePath(self), 'backups');

let config: Config;
try {
    config = parse(LoadResourceFile(self, 'config.json'));
} catch (err) {
    console.error(`fivecarcols: config.json is not valid JSON (${(err as Error).message}), using defaults`);
    config = parse(null);
}

let busy = false;
let pending: { key: string; at: number } | null = null;

function resources(): Resource[] {
    const out: Resource[] = [];
    for (let i = 0; i < GetNumResources(); i++) {
        const name = GetResourceByFindIndex(i);
        if (!name || name === self || GetResourceState(name) === 'missing') continue;
        const root = GetResourcePath(name);
        if (root) out.push({ name, root });
    }
    return out;
}

async function prepare(): Promise<Plan> {
    const files = await load(resources(), ignores(config.ignore));
    const r = (p: Pool) => reserved(config, p);
    return plan(files, {
        pools: pools.filter((p) => enabled(config, p)),
        max: { siren: max(config, 'siren'), light: max(config, 'light'), kit: max(config, 'kit') },
        reserved: { siren: r('siren'), light: r('light'), kit: r('kit') },
    });
}

function commit(p: Plan): { fix: Fix; restart: string[] } {
    const out = render(p);
    const writes = [...out].map(([f, text]) => ({
        resource: f.resource,
        root: f.root,
        path: f.path,
        before: Buffer.from(f.text, 'latin1'),
        data: Buffer.from(text, 'latin1'),
    }));
    const moves = p.moves.map((m) => ({ pool: m.pool, from: m.from, to: m.to, resource: m.claim.resource, name: m.claim.name }));
    const fix = write(backups, writes, moves);
    prune(backups, config.backups);
    return { fix, restart: [...new Set(writes.map((w) => w.resource))].sort() };
}

function undoLast() {
    const f = history(backups).find((h) => h.state !== 'undone');
    if (!f) throw new Error('no fix to undo');
    const rootOf = (name: string) => (GetResourceState(name) === 'missing' ? null : GetResourcePath(name) || null);
    return putBack(backups, f, rootOf);
}


const say = (s = '') => console.log(s.trimEnd());
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(1, n - s.replace(/\^\d/g, '').length));
const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? '' : /(s|sh|ch)$/.test(s) ? 'es' : 's'}`;
const label: Record<Pool, string> = { siren: 'siren', light: 'light', kit: 'kit' };

function describe(f: MetaFile) {
    const d = f.parsed.defs, r = f.parsed.refs;
    const n = (list: { pool: Pool }[], p: Pool) => list.filter((x) => x.pool === p).length;
    const parts: string[] = [];
    for (const p of pools) if (n(d, p)) parts.push(plural(n(d, p), label[p]));
    const used = r.filter((x) => x.id !== 0);
    const refs = pools.filter((p) => n(used, p)).map((p) => plural(n(used, p), label[p]));
    if (refs.length) parts.push(`uses ${refs.join(', ')}`);
    return parts.join(', ') || '^9nothing with an id^7';
}

function scan(p: Plan) {
    const byRes = new Map<string, MetaFile[]>();
    for (const f of p.files) byRes.set(f.resource, [...(byRes.get(f.resource) ?? []), f]);
    say(`carcols: ${plural(p.files.length, 'meta file')} in ${plural(byRes.size, 'resource')}`);
    const w = Math.max(10, ...p.files.map((f) => f.path.length)) + 2;
    for (const [res, files] of byRes) {
        say(`  ^5${res}^7${files[0]!.ignored ? '  ^9ignored^7' : ''}`);
        for (const f of files) say(`    ${pad(f.path, w)}${describe(f)}`);
    }
    say();

    let high = 0;
    for (const pool of pools) {
        const limit = max(config, pool);
        for (const f of p.files) {
            for (const d of f.parsed.defs) {
                if (d.pool !== pool || d.id <= limit) continue;
                const hint = pool === 'siren' && limit < 65534 ? '. Fine with SSLA, then set sirenMax to 65534 in config.json' : '';
                say(`  ^3${label[pool]} ${d.id} in ${f.resource}/${f.path}:${d.line} is above ${limit}${hint}^7`);
                high++;
            }
        }
    }
    if (high) say();

    if (!p.clashes.length) return say('carcols: ^2no clashes^7');
    say(`carcols: ^3${plural(p.clashes.length, 'clash')}^7`);
    const at = (cl: Claim) => `${cl.defs[0]!.file.path}:${cl.defs[0]!.def.line}`;
    const all = p.clashes.flatMap((c) => c.claims);
    const rw = Math.max(...all.map((cl) => cl.resource.length)) + 2;
    const aw = Math.max(...all.map((cl) => at(cl).length)) + 2;
    for (const c of p.clashes) {
        c.claims.forEach((cl, i) => {
            const head = i ? ' '.repeat(14) : pad(label[c.pool], 7) + pad(String(c.id), 7);
            const more = cl.defs.length > 1 ? `  ^9and ${plural(cl.defs.length - 1, 'more file')}^7` : '';
            say(`  ${head}${pad(cl.resource, rw)}${pad(at(cl), aw)}${pad(state(c, cl, i), 9)}${cl.name ? `^9${cl.name}^7` : ''}${more}`);
        });
    }
    say();
    say('Run "carcols fix" to see what fixing them changes.');
}

function state(c: Plan['clashes'][number], cl: Claim, i: number) {
    if (!enabled(config, c.pool)) return '^9off in config^7';
    if (c.reserved) return '^9reserved^7';
    if (i === 0) return '^2keeps^7';
    return cl.ignored ? '^9ignored^7' : '^3moves^7';
}

function preview(p: Plan) {
    for (const w of p.warnings) say(`  ^3${w}^7`);
    if (p.warnings.length) say();
    if (!p.moves.length) return say(p.clashes.length ? 'carcols: nothing to change' : 'carcols: ^2no clashes^7');
    say(`carcols: ${plural(p.moves.length, 'id')} to change, nothing is written yet`);
    say();
    const rw = Math.max(...p.moves.map((m) => m.claim.resource.length)) + 2;
    for (const m of p.moves) {
        const first = m.claim.defs[0]!;
        const name = m.name ? `  ${m.claim.name} -> ^2${m.name}^7` : m.claim.name ? `  ^9${m.claim.name}^7` : '';
        say(`  ${pad(label[m.pool], 7)}${pad(`${m.from} -> ^2${m.to}^7`, 20)}${pad(m.claim.resource, rw)}${first.file.path}:${first.def.line}${name}`);
        for (const d of m.claim.defs.slice(1)) say(`${' '.repeat(29 + rw)}${d.file.resource === m.claim.resource ? '' : d.file.resource + '/'}${d.file.path}:${d.def.line}`);
        const refs = m.refs.map((e) => ({ e, at: `${e.file.resource}/${e.file.path}:${line(e)}` }));
        const aw = Math.max(0, ...refs.map((r) => r.at.length)) + 2;
        for (const { e, at } of refs) {
            const l = lineOf(e);
            say(`         ^9${pad(at, aw)}^7${l.before}  ->  ^2${l.after}^7`);
        }
    }
    say();
}

const line = (e: Plan['moves'][number]['refs'][number]) => e.file.text.slice(0, e.at.start).split('\n').length;

function restartNote(names: string[], ids = 'new') {
    say(`carcols: restart the server to load the ${ids} ids. Changed: ${names.join(', ')}`);
}

async function run(args: string[]) {
    const [cmd, flag] = args;

    if (cmd === 'scan') return scan(await prepare());

    if (cmd === 'fix') {
        const p = await prepare();
        if (flag === 'confirm') {
            if (!pending || pending.key !== p.key || Date.now() - pending.at > 10 * 60e3) {
                preview(p);
                if (p.moves.length) {
                    pending = { key: p.key, at: Date.now() };
                    say('The files changed since the last preview, or there was none. Check the above and run "carcols fix confirm" again.');
                }
                return;
            }
            pending = null;
            if (!p.moves.length) return say('carcols: nothing to change');
            const { fix, restart } = commit(p);
            say(`carcols: ^2changed ${plural(p.moves.length, 'id')} in ${plural(fix.files.length, 'file')}^7. Backup in backups/${fix.id}, "carcols undo" puts it back.`);
            return restartNote(restart);
        }
        preview(p);
        if (p.moves.length) {
            pending = { key: p.key, at: Date.now() };
            say('Run "carcols fix confirm" to write it. The files are backed up first.');
        }
        return;
    }

    if (cmd === 'undo') {
        const f = undoLast();
        const done = f.files.length - (f.skipped?.length ?? 0);
        say(`carcols: put back the fix from ${new Date(f.time).toLocaleString()}, ${plural(done, 'file')}`);
        for (const s of f.skipped ?? []) say(`  ^3left alone, changed since the fix: ${s}^7`);
        return restartNote([...new Set(f.files.map((w) => w.resource))].sort(), 'old');
    }

    say('carcols scan           meta files and id clashes');
    say('carcols fix            what fixing them changes, writes nothing');
    say('carcols fix confirm    write it, with a backup');
    say('carcols undo           put the last fix back');
}

// console and rcon only, it writes files on the server
RegisterCommand('carcols', (src, args) => {
    if (src !== 0) return;
    if (busy) return say('carcols: still busy with the last command');
    busy = true;
    run(args)
        .catch((err) => say(`carcols: ${(err as Error).message}`))
        .finally(() => (busy = false));
}, true);

// A fix that crashed halfway is easy to miss, so say so on every start.
for (const f of history(backups)) {
    if (f.state === 'writing') console.warn(`fivecarcols: the fix from ${new Date(f.time).toLocaleString()} didn't finish. Run "carcols undo" to put it back.`);
}


async function locked<T>(fn: () => Promise<T> | T): Promise<T> {
    if (busy) throw new Error('fivecarcols is busy, try again in a moment');
    busy = true;
    try {
        return await fn();
    } finally {
        busy = false;
    }
}

const claimInfo = (cl: Claim) => ({
    resource: cl.resource,
    name: cl.name ?? null,
    files: cl.defs.map((d) => ({ resource: d.file.resource, path: d.file.path, line: d.def.line })),
});

const api: Record<string, (...args: any[]) => unknown> = {
    scan: () => locked(async () => {
        const p = await prepare();
        return {
            files: p.files.map((f) => ({ resource: f.resource, path: f.path, ignored: f.ignored, defs: f.parsed.defs.length, refs: f.parsed.refs.length })),
            clashes: p.clashes.map((c) => ({ pool: c.pool, id: c.id, keeps: claimInfo(c.claims[0]!), others: c.claims.slice(1).map(claimInfo) })),
        };
    }),
    fix: () => locked(async () => {
        const p = await prepare();
        return {
            changes: p.moves.map((m) => ({
                pool: m.pool, from: m.from, to: m.to, ...claimInfo(m.claim), rename: m.name ?? null,
                refs: m.refs.map((e) => ({ resource: e.file.resource, path: e.file.path, line: line(e), ...lineOf(e) })),
            })),
            warnings: p.warnings,
        };
    }),
    apply: () => locked(async () => {
        const p = await prepare();
        if (!p.moves.length) return { id: null, files: [], restart: [], warnings: p.warnings };
        const { fix, restart } = commit(p);
        console.log(`fivecarcols: ${plural(p.moves.length, 'id')} changed by another resource. "carcols undo" puts it back.`);
        return { id: fix.id, files: fix.files.map((f) => `${f.resource}/${f.path}`), restart, warnings: p.warnings };
    }),
    undo: () => locked(() => {
        const f = undoLast();
        return { id: f.id, files: f.files.map((w) => `${w.resource}/${w.path}`), skipped: f.skipped ?? [] };
    }),
};

const ex = (globalThis as any).exports;
for (const [name, fn] of Object.entries(api)) ex(name, fn);
