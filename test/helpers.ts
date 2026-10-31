import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { load, type Resource } from '../src/find';
import { plan, type Options } from '../src/plan';

export const siren = (id: number | string, name = 'siren') => `
    <Item>
      <id value="${id}" />
      <name>${name}</name>
      <sirens>
        <Item>
          <rotation>
            <delta value="0.00000000" />
          </rotation>
        </Item>
      </sirens>
    </Item>`;

export const light = (id: number | string) => `
    <Item>
      <id value="${id}" />
      <indicator>
        <intensity value="1.00000000" />
      </indicator>
    </Item>`;

export const kit = (id: number | string, name: string) => `
    <Item>
      <kitName>${name}</kitName>
      <id value="${id}" />
      <kitType>MKT_SPECIAL</kitType>
      <visibleMods>
        <Item>
          <modelName>livery1</modelName>
          <weight value="20" />
        </Item>
      </visibleMods>
    </Item>`;

export function carcols(o: { sirens?: string[]; lights?: string[]; kits?: string[] }) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<CVehicleModelInfoVarGlobal>
  <Kits>${(o.kits ?? []).join('')}
  </Kits>
  <Lights>${(o.lights ?? []).join('')}
  </Lights>
  <Sirens>${(o.sirens ?? []).join('')}
  </Sirens>
</CVehicleModelInfoVarGlobal>
`;
}

export function vehicle(model: string, o: { kits?: string[]; siren?: number; light?: number }) {
    return `
    <Item>
      <modelName>${model}</modelName>
      <kits>
${(o.kits ?? ['0_default_modkit']).map((k) => `        <Item>${k}</Item>`).join('\n')}
      </kits>
      <lightSettings value="${o.light ?? 0}" />
      <sirenSettings value="${o.siren ?? 0}" />
    </Item>`;
}

export const carvariations = (items: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<CVehicleModelInfoVariation>
  <variationData>${items.join('')}
  </variationData>
</CVehicleModelInfoVariation>
`;

// A server folder: { "[cars]/police/data/carcols.meta": "..." }, every first
// folder that isn't a [category] (or the one after it) is a resource.
export function server(files: Record<string, string | Buffer>) {
    const dir = mkdtempSync(join(tmpdir(), 'fivecarcols-'));
    const root = join(dir, 'resources');
    const res = new Map<string, Resource>();
    for (const [p, data] of Object.entries(files)) {
        const full = join(root, p);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, data);
        const parts = p.split('/');
        const i = parts[0]!.startsWith('[') ? 1 : 0;
        const name = parts[i]!;
        res.set(name, { name, root: join(root, ...parts.slice(0, i + 1)) });
    }
    return { dir, root, resources: [...res.values()], read: (p: string) => readFileSync(join(root, p)), text: (p: string) => readFileSync(join(root, p), 'latin1') };
}

export const opts = (o: Partial<Options> = {}): Options => ({
    pools: ['siren', 'light', 'kit'],
    max: { siren: 254, light: 255, kit: 65535 },
    reserved: { siren: new Set(), light: new Set(), kit: new Set() },
    ...o,
});

export async function planFor(resources: Resource[], o?: Partial<Options>, ignored?: (r: Resource) => boolean) {
    return plan(await load(resources, ignored), opts(o));
}
