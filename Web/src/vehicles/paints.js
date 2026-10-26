/**
 * Shared paint palette.
 *
 * Each vehicle's `paint.palette` lists which of these ids it offers, so a
 * hatchback can be bright and a supercar can have a metallic finish without
 * duplicating colour literals across definitions.
 */
export const PAINTS = {
  factory: { label: 'Factory', hex: 0xd7dbe0, metalness: 0.45, roughness: 0.42 },
  racingRed: { label: 'Racing Red', hex: 0xd7263d, metalness: 0.5, roughness: 0.34 },
  midnightBlue: { label: 'Midnight Blue', hex: 0x1b3a6b, metalness: 0.55, roughness: 0.33 },
  pearlWhite: { label: 'Pearl White', hex: 0xf2f4f7, metalness: 0.3, roughness: 0.3 },
  sunburstYellow: { label: 'Sunburst', hex: 0xf5c518, metalness: 0.45, roughness: 0.36 },
  forestGreen: { label: 'Forest Green', hex: 0x1f5c3a, metalness: 0.4, roughness: 0.4 },
  graphite: { label: 'Graphite', hex: 0x3a3f45, metalness: 0.6, roughness: 0.38 },
  sand: { label: 'Desert Sand', hex: 0xc2a878, metalness: 0.25, roughness: 0.55 },
  olive: { label: 'Olive', hex: 0x5b5f3a, metalness: 0.3, roughness: 0.5 },
  burntOrange: { label: 'Burnt Orange', hex: 0xd2691e, metalness: 0.5, roughness: 0.35 },
};

/** Resolve a paint id, falling back to `factory` for unknown ids. */
export function resolvePaint(id) {
  return PAINTS[id] ?? PAINTS.factory;
}

export const DEFAULT_PAINT_ID = 'factory';
