import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LOCAL_MODEL_INFO, type LocalModelId, type LocalModelPreference, type LocalModelTier } from '@shared/speech';
import type { Casing } from './format';
import catalog from './catalog.json';

export type { LocalModelId, LocalModelPreference, LocalModelTier };

/**
 * The speech models Candor can run on this PC. Both are streaming transducers (audio in, words out continuously)
 * from the open-source k2-fsa / sherpa-onnx project, int8-quantised so they run in real time on an ordinary laptop CPU.
 * They ship inside the installer, so speech recognition works offline, with no account, key or payment.
 *
 * Measured on the development machine (AMD Ryzen 5 3500U, 4 cores, no discrete GPU, one decoding thread):
 * see docs/SPEECH.md and `npm run bench:stt`. The numbers there are the source of truth, not these descriptions.
 */

export interface ModelFile {
  /** File name inside the model folder. */
  name: string;
  bytes: number;
  /** Pinned SHA-256, checked by `npm run models` (and by the fetch step), not at every start. */
  sha256: string;
}

export interface LocalModelSpec {
  id: LocalModelId;
  tier: LocalModelTier;
  label: string;
  description: string;
  files: { encoder: ModelFile; decoder: ModelFile; joiner: ModelFile; tokens: ModelFile };
  /** How the model writes its text: ALL CAPS (needs sentence-casing) or already mixed case. */
  casing: Casing;
  /** Audio the model looks at per step; the floor for how late a word can appear. */
  chunkMs: number;
  license: string;
  source: string;
}

const MB = 1_048_576;

/**
 * File names, sizes and SHA-256 hashes live in catalog.json so that `scripts/fetch-models.mjs` (plain Node, no
 * TypeScript) and the app read the very same pinned values.
 */
type CatalogEntry = Pick<LocalModelSpec, 'files' | 'casing' | 'chunkMs' | 'license' | 'source'>;
const CATALOG = catalog as Record<LocalModelId, CatalogEntry>;

function spec(id: LocalModelId): LocalModelSpec {
  const info = LOCAL_MODEL_INFO[id];
  return { id, tier: info.tier, label: info.label, description: info.description, ...CATALOG[id] };
}

export const LOCAL_MODELS: Record<LocalModelId, LocalModelSpec> = {
  'x-asr-160': spec('x-asr-160'),
  'zipformer-en-70m': spec('zipformer-en-70m'),
};

export function modelBytes(spec: LocalModelSpec): number {
  return Object.values(spec.files).reduce((n, f) => n + f.bytes, 0);
}

export function modelSizeLabel(spec: LocalModelSpec): string {
  return `${Math.round(modelBytes(spec) / MB)} MB`;
}

export interface Hardware {
  cores: number;
  totalMemGB: number;
}

/**
 * Which model to use. "Auto" picks the accurate one when the PC has the cores and memory for it; the light one
 * otherwise. (While listening, the accurate model can still step down to the light one if it falls behind.)
 */
export function chooseModel(pref: LocalModelPreference, hw: Hardware): LocalModelId {
  if (pref === 'accurate') return 'x-asr-160';
  if (pref === 'light') return 'zipformer-en-70m';
  return hw.cores >= 6 && hw.totalMemGB >= 6 ? 'x-asr-160' : 'zipformer-en-70m';
}

/** The other model to fall back to when this one cannot keep up (none for the light one: nothing lighter exists). */
export function lighterThan(id: LocalModelId): LocalModelId | null {
  return id === 'x-asr-160' ? 'zipformer-en-70m' : null;
}

export interface ModelRoots {
  /** `process.resourcesPath` in the installed app. */
  resourcesPath?: string;
  /** The project folder in development. */
  appRoot?: string;
  /** Models the user added themselves, under the user-data folder. */
  userData?: string;
  /** Explicit override (tests, portable setups). */
  override?: string;
}

/** Folders that may hold `<model id>/…`, most specific first. */
export function modelSearchRoots(r: ModelRoots): string[] {
  const roots: string[] = [];
  if (r.override) roots.push(r.override);
  if (r.userData) roots.push(join(r.userData, 'models', 'stt'));
  if (r.resourcesPath) roots.push(join(r.resourcesPath, 'models', 'stt'));
  if (r.appRoot) roots.push(join(r.appRoot, 'resources', 'models', 'stt'));
  return roots;
}

export interface LocatedModel {
  spec: LocalModelSpec;
  dir: string;
  paths: { encoder: string; decoder: string; joiner: string; tokens: string };
}

export type ModelLookup = { ok: true; model: LocatedModel } | { ok: false; reason: 'missing' | 'incomplete'; searched: string[]; problems: string[] };

/** Is the model present and complete? Checks that every file exists with the expected size (hashes are checked by `npm run models`). */
export function locateModel(id: LocalModelId, roots: string[], specs: Record<LocalModelId, LocalModelSpec> = LOCAL_MODELS): ModelLookup {
  const spec = specs[id];
  const problems: string[] = [];
  let sawFolder = false;
  for (const root of roots) {
    const dir = join(root, id);
    if (!existsSync(dir)) continue;
    sawFolder = true;
    const bad: string[] = [];
    for (const f of Object.values(spec.files)) {
      try {
        const st = statSync(join(dir, f.name));
        if (!st.isFile()) bad.push(`${f.name} is not a file`);
        else if (st.size !== f.bytes) bad.push(`${f.name} has ${st.size} bytes, expected ${f.bytes}`);
      } catch {
        bad.push(`${f.name} is missing`);
      }
    }
    if (bad.length === 0) {
      const paths = {
        encoder: join(dir, spec.files.encoder.name),
        decoder: join(dir, spec.files.decoder.name),
        joiner: join(dir, spec.files.joiner.name),
        tokens: join(dir, spec.files.tokens.name),
      };
      return { ok: true, model: { spec, dir, paths } };
    }
    problems.push(`${dir}: ${bad.join('; ')}`);
  }
  return { ok: false, reason: sawFolder ? 'incomplete' : 'missing', searched: roots.map((r) => join(r, id)), problems };
}
