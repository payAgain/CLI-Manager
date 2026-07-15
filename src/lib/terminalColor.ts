// Pure color helpers for the terminal renderer: hex validation and rgba
// conversion. No xterm runtime dependency.

export const normalizeHexColor = (value: string | undefined, fallback: string) => (
  value && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback
);

export const hexToRgba = (value: string | undefined, alpha: number, fallback: string) => {
  const normalized = normalizeHexColor(value, "");
  if (!normalized) return fallback;
  const hex = normalized.slice(1);
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};
