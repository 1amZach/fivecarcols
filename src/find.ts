import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { parse, type Parsed } from './meta';

export interface Resource {
    name: string;
    root: string;
}

export interface MetaFile {
    resource: string;
    root: string;
    path: string; // inside the resource, with forward slashes
    abs: string;
    text: string; // latin1, so every byte maps to one character and back
    parsed: Parsed;
    ignored: boolean;
}

const skipDirs = new Set(['node_modules', '.git', 'backups']);

// carcols.meta, carvariations.meta and the renamed copies packs ship, like police_carcols.meta
export const isMeta = (name: string) => /(carcols|carvariations).*\.meta$/i.test(name);

async function walk(dir: string, skip: Set<string>, out: string[]) {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        if (e.isSymbolicLink()) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
            if (!skipDirs.has(e.name.toLowerCase()) && !skip.has(full)) await walk(full, skip, out);
        } else if (e.isFile() && isMeta(e.name)) {
            out.push(full);
        }
    }
}

export function ignores(list: string[]) {
    const names = new Set(list.map((s) => s.toLowerCase()));
    return (r: Resource) => names.has(r.name.toLowerCase()) || r.root.split(/[\\/]/).some((p) => p.startsWith('[') && names.has(p.toLowerCase()));
}

export async function load(resources: Resource[], ignored: (r: Resource) => boolean = () => false): Promise<MetaFile[]> {
    const list = resources.map((r) => ({ ...r, root: resolve(r.root) })).sort((a, b) => a.root.length - b.root.length);
    const roots = new Set(list.map((r) => r.root));
    const files: MetaFile[] = [];
    const seen = new Set<string>();

    for (const r of list) {
        if (seen.has(r.root)) continue;
        seen.add(r.root);
        // another resource inside this one is scanned on its own
        const skip = new Set([...roots].filter((p) => p !== r.root && p.startsWith(r.root + sep)));
        const found: string[] = [];
        await walk(r.root, skip, found);
        for (const abs of found) {
            let text;
            try {
                text = (await readFile(abs)).toString('latin1');
            } catch {
                continue;
            }
            const path = relative(r.root, abs).split(sep).join('/');
            files.push({ resource: r.name, root: r.root, path, abs, text, parsed: parse(text), ignored: ignored(r) });
        }
    }
    return files.sort((a, b) => cmp(a.resource, b.resource) || cmp(a.path, b.path));
}

export const cmp = (a: string, b: string) => {
    const x = a.toLowerCase(), y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
};
