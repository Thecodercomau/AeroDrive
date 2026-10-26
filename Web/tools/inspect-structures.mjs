import { MAPS } from '../src/world/maps.js';
import { Terrain } from '../src/terrain/Terrain.js';
import { RoadNetwork } from '../src/roads/RoadNetwork.js';
import {
  resolveSpans,
  applyAlignedProfile,
  coverOver,
  clearanceOver,
} from '../src/roads/structures.js';

/**
 * Map-authoring helper: where would a bridge or a tunnel land on each road?
 *
 * Bridges and tunnels are placed by the terrain (see `src/roads/structures.js`),
 * not by hand, so the only way to know whether a road *has* a valley worth
 * bridging is to ask. This prints, per road, the best bridge and tunnel window
 * the resolver can find, its score, and how much clearance or cover it actually
 * achieves — which is the number to compare against the minimums in
 * `STRUCTURE_DEFAULTS`.
 *
 * Usage: node tools/inspect-structures.mjs [mapId]
 */

const only = process.argv[2] ?? null;
const round = (value, digits = 1) => (Number.isFinite(value) ? value.toFixed(digits) : '—');

for (const map of MAPS) {
  if (only && map.id !== only) continue;
  const terrain = new Terrain({ ...map.terrain });
  const heightAt = (x, z) => terrain.heightAt(x, z);
  const roads = new RoadNetwork();
  for (const definition of map.buildRoads()) roads.add(definition);
  roads.projectAll(heightAt, {
    segments: Math.max(160, Math.round(map.terrain.size / 10)),
    surfaceOffset: 0.06,
  });

  console.log(`\n=== ${map.name} (${map.id}) ===`);
  for (const road of roads.roads) {
    const length = road.centreline.length
      ? Math.hypot(
          road.centreline[road.centreline.length - 1].x - road.centreline[0].x,
          road.centreline[road.centreline.length - 1].z - road.centreline[0].z,
        )
      : 0;
    console.log(
      `  ${road.name} (width ${road.width}, ${road.centreline.length} samples, straight-line ${round(length, 0)} m)`,
    );

    const diagnostics = [];
    const context = { heightAt, width: road.width, diagnostics };

    const [bridge] = resolveSpans(road.centreline, [{ type: 'bridge' }], context);
    if (bridge) {
      // The alignment has to be applied to know the clearance the deck ends up
      // with over its whole span, not just over the searched window.
      const probe = road.centreline.map((point) => ({ ...point }));
      applyAlignedProfile(probe, { ...bridge, heightAt });
      console.log(
        `    bridge : at ${round(bridge.startDistance, 0)}–${round(bridge.endDistance, 0)} m ` +
          `(${round(bridge.length, 0)} m), window fit ${round(bridge.windowFit)} m, ` +
          `span fit ${round(bridge.minFit)} m, min clearance ${round(clearanceOver(probe, bridge, heightAt))} m`,
      );
    } else {
      const why = diagnostics.find((entry) => entry.type === 'bridge');
      console.log(`    bridge : none justified — ${why?.reason ?? 'unknown'}`);
    }

    const [tunnel] = resolveSpans(road.centreline, [{ type: 'tunnel' }], context);
    if (tunnel) {
      const aligned = road.centreline.map((point) => ({ ...point }));
      applyAlignedProfile(aligned, tunnel);
      const cover = coverOver(aligned, tunnel, heightAt);
      console.log(
        `    tunnel : at ${round(tunnel.startDistance, 0)}–${round(tunnel.endDistance, 0)} m ` +
          `(${round(tunnel.length, 0)} m), window fit ${round(tunnel.windowFit)} m, ` +
          `span fit ${round(tunnel.minFit)} m, min cover ${round(cover.minCover)} m, ` +
          `mean cover ${round(cover.meanCover)} m`,
      );
    } else {
      const why = diagnostics.find((entry) => entry.type === 'tunnel');
      console.log(`    tunnel : none justified — ${why?.reason ?? 'unknown'}`);
    }
  }

  terrain.dispose();
}
