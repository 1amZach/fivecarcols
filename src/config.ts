import type { Pool } from './meta';

export interface Config {
    pools: { sirens: boolean; lights: boolean; kits: boolean };
    sirenMax: number; // 254, or 65534 with SSLA
    ignore: string[]; // resource names or [category] folders, read but never changed
    reserved: { sirens: Ids; lights: Ids; kits: Ids };
    backups: number;
}

type Ids = (number | string)[]; // 12 or "100-120"

export const defaults: Config = {
    pools: { sirens: true, lights: true, kits: true },
    sirenMax: 254,
    ignore: [],
    reserved: { sirens: [], lights: [], kits: [] },
    backups: 10,
};

export function parse(raw: string | null): Config {
    if (!raw) return defaults;
    const c = JSON.parse(raw);
    return {
        ...defaults,
        ...c,
        pools: { ...defaults.pools, ...c.pools },
        reserved: { ...defaults.reserved, ...c.reserved },
    };
}

const key: Record<Pool, keyof Config['pools']> = { siren: 'sirens', light: 'lights', kit: 'kits' };

export const enabled = (c: Config, pool: Pool) => c.pools[key[pool]] !== false;

export function reserved(c: Config, pool: Pool): Set<number> {
    const out = new Set<number>();
    for (const v of c.reserved[key[pool]] ?? []) {
        const m = String(v).match(/^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/);
        if (!m) continue;
        const a = Number(m[1]), b = Number(m[2] ?? m[1]);
        for (let i = Math.min(a, b); i <= Math.max(a, b) && i <= 65535; i++) out.add(i);
    }
    return out;
}

export function max(c: Config, pool: Pool) {
    if (pool === 'siren') return Math.min(Math.max(Math.floor(c.sirenMax) || 254, 1), 65534);
    return pool === 'light' ? 255 : 65535;
}
