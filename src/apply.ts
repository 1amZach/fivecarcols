import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

// Every fix keeps the files it changed in backups/<id>/files and a record in
// backups/<id>/fix.json, written before anything is touched, so it can be put
// back even after a crash halfway through.

export interface Written {
    resource: string;
    root: string;
    path: string; // inside the resource
    backup: string; // file name under backups/<id>/files
    hash: string; // what we wrote
}

export interface Fix {
    id: string;
    time: number;
    state: 'writing' | 'done' | 'undone';
    files: Written[];
    moves: { pool: string; from: number; to: number; resource: string; name?: string }[];
    skipped?: string[]; // left alone on undo because they changed after
}

export interface Write {
    resource: string;
    root: string;
    path: string;
    before: Uint8Array; // as it was read when the plan was made
    data: Uint8Array;
}

export const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function read(file: string): Buffer | null {
    try {
        return readFileSync(file);
    } catch {
        return null;
    }
}

function write(file: string, data: Uint8Array) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = file + '.fivecarcols';
    writeFileSync(tmp, data);
    renameSync(tmp, file);
}

// A path inside the resource folder, or an error. Nothing is ever written anywhere else.
export function target(root: string, path: string) {
    if (!path || isAbsolute(path) || path.split(/[\\/]/).some((p) => p === '..' || p === '')) throw new Error(`refusing to write ${path}`);
    const base = realpathSync(root);
    const full = resolve(base, path);
    if (!full.startsWith(base + sep)) throw new Error(`refusing to write ${path} outside ${root}`);
    const real = realpathSync(dirname(full));
    if (real !== base && !real.startsWith(base + sep)) throw new Error(`refusing to write ${path} through a link`);
    if (existsSync(full) && lstatSync(full).isSymbolicLink()) throw new Error(`refusing to write ${path}, it's a link`);
    return full;
}

const save = (dir: string, f: Fix) => write(join(dir, f.id, 'fix.json'), Buffer.from(JSON.stringify(f, null, 2)));

export function apply(dir: string, writes: Write[], moves: Fix['moves']): Fix {
    const time = Date.now();
    const f: Fix = { id: `fix-${time}`, time, state: 'writing', files: [], moves };
    const todo = writes.map((w) => ({ w, full: target(w.root, w.path) }));

    for (const { w, full } of todo) {
        const now = read(full);
        if (!now || hash(now) !== hash(w.before)) throw new Error(`${w.resource}/${w.path} changed since it was read, run the fix again`);
    }
    todo.forEach(({ w }, i) => {
        const backup = `${i}.meta`;
        write(join(dir, f.id, 'files', backup), w.before);
        f.files.push({ resource: w.resource, root: w.root, path: w.path, backup, hash: hash(w.data) });
    });
    save(dir, f);

    for (const { w, full } of todo) write(full, w.data);
    f.state = 'done';
    save(dir, f);
    return f;
}

export function history(dir: string): Fix[] {
    if (!existsSync(dir)) return [];
    const out: Fix[] = [];
    for (const id of readdirSync(dir)) {
        const raw = read(join(dir, id, 'fix.json'));
        if (!raw) continue;
        try {
            out.push(JSON.parse(raw.toString()));
        } catch {
            // half-written record from a crash before anything was touched
        }
    }
    return out.sort((a, b) => b.time - a.time);
}

// Puts back what a fix changed. A file that has changed since is left alone
// and listed in `skipped`.
export function undo(dir: string, f: Fix, rootOf: (resource: string) => string | null = () => null): Fix {
    const skipped: string[] = [];
    for (const w of [...f.files].reverse()) {
        const full = target(rootOf(w.resource) ?? w.root, w.path);
        const now = read(full);
        const backup = read(join(dir, f.id, 'files', w.backup));
        if (!backup) {
            skipped.push(`${w.resource}/${w.path}`);
            continue;
        }
        if (now && hash(now) === hash(backup)) continue; // never got written
        if (!now || hash(now) !== w.hash) {
            skipped.push(`${w.resource}/${w.path}`);
            continue;
        }
        write(full, backup);
    }
    f.state = 'undone';
    f.skipped = skipped;
    save(dir, f);
    return f;
}

export function prune(dir: string, keep: number) {
    history(dir).forEach((f, i) => {
        if (i >= keep && f.state !== 'writing') rmSync(join(dir, f.id), { recursive: true, force: true });
    });
}
