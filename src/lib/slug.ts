const UNKNOWN = 'unknown';

export function slug(name: string | null | undefined, fallback = UNKNOWN): string {
  const raw = (name ?? '').trim() || fallback;
  return raw
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/g, '')
    .trim()
    .slice(0, 80) || fallback;
}
