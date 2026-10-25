/**
 * Your company: founded at the start of a career with a government start-up grant (the starting
 * cash), a name and a logo of your own (ui/logo.ts). Saved with the game.
 */
import { ECONOMY } from '../balance';
import { sanitizeLogo, type LogoSpec } from '../ui/logo';

export type GrantKind = 'generous' | 'standard' | 'lean';

export const GRANTS: { id: GrantKind; name: string; mult: number; blurb: string }[] = [
  { id: 'generous', name: 'Generous', mult: 1.5, blurb: 'Easy: room to build big early' },
  { id: 'standard', name: 'Standard', mult: 1, blurb: 'The intended challenge' },
  { id: 'lean', name: 'Lean', mult: 0.6, blurb: 'Hard: every line has to pay its way' },
];

export interface Company {
  name: string;
  logo: LogoSpec;
  grantKind: GrantKind;
  /** The grant paid on day one (0 in Sandbox). */
  grant: number;
  /** Game day it was founded. */
  founded: number;
}

export const grantAmount = (k: GrantKind): number => ECONOMY.startingCash * (GRANTS.find((g) => g.id === k)?.mult ?? 1);

/** A company from a save (or null when absent or unusable). */
export function sanitizeCompany(raw: unknown): Company | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name.trim().slice(0, 40) : '';
  if (!name) return null;
  const grantKind = GRANTS.some((g) => g.id === o.grantKind) ? (o.grantKind as GrantKind) : 'standard';
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return { name, logo: sanitizeLogo(o.logo), grantKind, grant: num(o.grant), founded: num(o.founded) };
}
