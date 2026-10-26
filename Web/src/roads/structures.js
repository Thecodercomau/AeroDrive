import * as THREE from 'three';
import { clamp, lerp } from '../utilities/math.js';

/**
 * Road structures: bridges and tunnels.
 *
 * Both prompts ask for bridges and tunnels, and both break the assumption the
 * world pipeline is built on — that a road samples the terrain and sits on it.
 * A bridge is *above* the ground; a tunnel is *below* the surface of a hill.
 *
 * The pipeline was probed before either was designed (see
 * `tools/probe-heightfield-sides.mjs`). The important result: a Rapier
 * heightfield does not collide with a body underneath it, and a body resting on
 * a road under 11 m of heightfield is completely stable. So a road may pass
 * through a hill, and the hill may be left intact above it. That is what makes a
 * real tunnel possible; without it a tunnel could only ever be a cut-and-cover
 * shell lying in an open trench.
 *
 * ## How a structure is placed
 *
 * Neither structure is positioned by hand. A road *declares* that it wants one
 * (`structures: [{ type: 'bridge' }]`) and the terrain decides where, if
 * anywhere:
 *
 *  1. **Align.** For a candidate window of `length` metres, the road's vertical
 *     alignment is replaced by the straight line between the window's two ends.
 *     That is what makes a bridge a *bridge* (a level deck over a dip) and a
 *     tunnel a *tunnel* (a level bore through a hill) rather than a road that
 *     politely climbs over both.
 *     The line clears the ground on both sides of the road too, not just along
 *     the centreline, so a route that merely clips the shoulder of a hill is
 *     rejected.
 *  2. **Choose where.** Candidate windows are compared by their *mean* fit, so
 *     the window lands on the feature rather than merely touching it; a hill's
 *     summit sits in the middle of the window rather than at its edge.
 *  3. **Accept or refuse.** A window whose *deepest* point never clears the
 *     minimum is not placed, and the refusal is reported in the console rather
 *     than papered over. The deepest point, not the average, is what decides
 *     this: one deep pocket of rock is what a bore needs, and one deep gap is
 *     what a deck needs. A road that crosses no gap gets no bridge.
 *  4. **Extend.** The span is then grown outwards while the road is still at or
 *     below the ground (bridge) or still covered by it (tunnel). This is what
 *     puts the abutments exactly where the deck meets the ground, and the portals
 *     exactly where the road emerges from the hill, so the terrain's cut-and-fill
 *     boundary and the structure's ends coincide and there is no step to see.
 *     Reaching the edge of the window is the signal that the window was too
 *     small, and the search is retaken over a wider one — see `resolveSpans`.
 *
 * Only the *vertical* alignment is straightened. A structure's plan geometry is
 * the road's own: `sweepProfile` walks the centreline, so a deck and a bore curve
 * exactly as far as the road they belong to does.
 *
 * ## What the terrain does underneath
 *
 * Inside a span the terrain is left completely alone: no cut, no fill. Since the
 * span only exists where the alignment is at or below the ground (a bridge) or
 * covered by it (a tunnel), the road never floats and never intrudes. The road
 * ribbon remains the driving surface in both cases, so the car is on the same
 * trimesh collider it uses on every other road.
 */

/** Defaults per structure type, overridable in the declaration. */
export const STRUCTURE_DEFAULTS = {
  bridge: {
    /**
     * Initial length of the window searched, in metres. It is only a starting
     * point: a span that runs into the window's edge with the ground still
     * opening up outside it widens the window and is decided again, so a gorge
     * wider than this still gets abutments on its own banks.
     */
    length: 150,
    /** Deepest point of the gap that is worth bridging, in metres. */
    minClearance: 6.5,
    /** Crown height at mid-span; the deck is not dead flat. */
    crown: 1.6,
    /** Shortest span worth building, in metres. */
    minSpan: 25,
    /**
     * Judged by the deepest point in the window, like the tunnel — and for the
     * same reason. Judging a bridge by the WORST point in a 150 m window rejects
     * every bridge on every road, because the window's ends are by definition
     * where the road is back on the ground. The depth is what makes a gap worth
     * bridging; how much of it needs bridging is then settled by the span, which
     * is grown out to the ground and has to be at least `minSpan` long.
     */
    reducer: 'max',
  },
  tunnel: {
    /** Initial window length; widened when a span reaches its edge. */
    length: 200,
    /**
     * Smallest depth of ground above the crown that is acceptable. The crown is
     * 6.2 m, so this leaves a metre of rock over the tunnel at the thinnest
     * point of the whole bore.
     */
    minClearance: 7,
    crown: 0,
    minSpan: 45,
    reducer: 'max',
  },
};

/** Tunnel cross-section: a horseshoe, in metres, relative to the road centre. */
export const TUNNEL_PROFILE = {
  halfWidth: 6.2,
  wallHeight: 4,
  apex: 6.2,
};

/** Rock left between the tunnel's outer surface and the hillside above it. */
const TUNNEL_ROCK_MARGIN = 0.8;

/**
 * Spacing between the point lights inside a tunnel, in metres, per graphics
 * preset.
 *
 * The tunnel lamps are emissive geometry and cost nothing, but they are not
 * light sources: without these the inside of a tunnel is lit by the same ambient
 * light as the open road, which reads as a tunnel with the roof missing. Real
 * point lights are expensive in a forward renderer — every one of them costs a
 * shader permutation and per-fragment work on every lit surface in the scene,
 * whether or not the player is anywhere near the tunnel — so they scale with the
 * preset like everything else in the quality ladder. `potato` keeps the emissive
 * strip and nothing else.
 */
export const TUNNEL_LIGHT_SPACING = {
  potato: 0,
  low: 45,
  medium: 28,
  high: 18,
};

/**
 * Hard ceiling on tunnel lights per map.
 *
 * Two tunnels lit at `high` spacing is about a dozen lights, which is already a
 * lot of per-fragment work for a scene where the player is only ever inside one
 * of them. Beyond this the spacing is widened rather than the count raised.
 */
const MAX_TUNNEL_LIGHTS = 10;

/**
 * How far past its declared length a search window may be widened.
 *
 * A span that reaches the edge of its window with the ground still opening up
 * outside it widens the window and is decided again, which is what stops a wide
 * hill from having its portals left in the cut face at the window's edge. The
 * growth is capped because the *alignment* is drawn over the whole window: an
 * unbounded window would mean that a road which stays above (or below) the
 * ground for kilometres could have kilometres of its vertical alignment
 * straightened by one declaration.
 */
const MAX_WINDOW_GROWTH = 3;

/** Deck thickness, in metres. Shared by the fit test and the deck geometry. */
export const DECK_THICKNESS = 1;

/* ------------------------------- pure maths ------------------------------- */

/** Arc length from the first sample to each sample, in the ground plane. */
export function cumulativeDistances(points) {
  const out = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) {
    out[i] = out[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  }
  return out;
}

/** Index of the first sample at or beyond `distance` metres (clamped). */
export function indexAtDistance(distances, distance) {
  const last = distances.length - 1;
  if (distance <= 0) return 0;
  if (distance >= distances[last]) return last;
  let low = 0;
  let high = last;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (distances[mid] < distance) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Unit left-of-travel vector at every centreline sample.
 *
 * The same perpendicular `buildRibbon` and `sweepProfile` use, so "6 m to the
 * left of the road" means the same thing to the terrain probe, the tunnel shell
 * and the road surface.
 */
export function lateralVectors(centreline) {
  const out = [];
  for (let i = 0; i < centreline.length; i++) {
    const previous = centreline[Math.max(0, i - 1)];
    const next = centreline[Math.min(centreline.length - 1, i + 1)];
    let tx = next.x - previous.x;
    let tz = next.z - previous.z;
    const length = Math.hypot(tx, tz) || 1;
    tx /= length;
    tz /= length;
    out.push({ x: -tz, z: tx });
  }
  return out;
}

/**
 * Height of a closed cross-section at a given lateral offset.
 *
 * The cross-section is read as "how high is the surface at this distance from
 * the centreline", taking the highest edge that spans the offset. For the tunnel
 * horseshoe that is the crown over the middle and the wall at the sides.
 *
 * @param {Array<{x:number,y:number}>} profile
 * @param {number} lateral
 */
export function profileHeightAt(profile, lateral) {
  let best = 0;
  for (let i = 0; i < profile.length; i++) {
    const a = profile[i];
    const b = profile[(i + 1) % profile.length];
    const low = Math.min(a.x, b.x);
    const high = Math.max(a.x, b.x);
    if (lateral < low - 1e-6 || lateral > high + 1e-6) continue;
    const span = b.x - a.x;
    const t = Math.abs(span) < 1e-6 ? 0 : (lateral - a.x) / span;
    best = Math.max(best, lerp(a.y, b.y, t));
  }
  return best;
}

/**
 * The signed margin at one centreline sample, given a candidate alignment
 * height for it. Positive means the structure fits.
 *
 * Both types sample either side of the centreline as well as the centre, so a
 * window is only accepted when the *whole width* of the structure fits, not just
 * the strip the centreline runs down.
 *
 * @param {'bridge'|'tunnel'} type
 * @param {object} sample `{ x, z, terrain, lateral, halfWidth, crownHeight }`
 * @param {number} aligned Road height under the candidate alignment.
 * @param {Array<{x:number,y:number}>} profile Cross-section (tunnel only).
 * @param {{heightAt:Function, width:number}} context
 */
function signedFit(type, sample, aligned, profile, { heightAt, width }) {
  const offsets =
    type === 'tunnel'
      ? [-sample.halfWidth * 0.95, 0, sample.halfWidth * 0.95]
      : [-(width / 2 + 0.9), 0, width / 2 + 0.9];

  let worst = Infinity;
  for (const offset of offsets) {
    const ground = heightAt(
      sample.x + sample.lateral.x * offset,
      sample.z + sample.lateral.z * offset,
    );
    if (type === 'tunnel') {
      // Rock above the tunnel: how far the ground is ABOVE the shell.
      const surface = aligned + profileHeightAt(profile, offset) + TUNNEL_ROCK_MARGIN;
      worst = Math.min(worst, ground - surface);
    } else {
      // Air under the deck: how far the deck is ABOVE the ground. Measured at
      // the deck's underside, and without the crown, so the answer is the
      // worst case rather than the best.
      worst = Math.min(worst, aligned - DECK_THICKNESS - ground);
    }
  }
  return worst;
}

/**
 * The window of `length` metres starting at sample index `start`.
 *
 * A window that runs off the end of the road is refused rather than shortened.
 * This matters to the search below: candidate windows are compared by their
 * *mean* fit, so a shortened window — which by definition covers only the higher
 * ground nearest the road's end — would win the comparison for the wrong reason,
 * and the structure would be placed in a corner instead of on the feature. Every
 * window the search sees is therefore the same length, or it is not seen.
 */
function windowAt(distances, start, length) {
  const end = indexAtDistance(distances, distances[start] + length);
  if (end - start < 2) return null;
  if (distances[end] - distances[start] < length - 1e-6) return null;
  return { start, end };
}

/**
 * Resolve structure declarations against the terrain.
 *
 * @param {Array<{x:number,y:number,z:number}>} centreline Graded road centreline.
 * @param {Array<{type:string, at?:number, length?:number}>} declarations
 * @param {{heightAt:Function, width?:number, profile?:Array<{x:number,y:number}>,
 *          diagnostics?:Array<object>}} options
 *   `heightAt` must be the NATURAL ground, before any road flattening. Anything
 *   pushed to `diagnostics` is a structure that was asked for and refused, with
 *   the best score the road could offer — so a map author can see how far off a
 *   road is instead of only being told no.
 * @returns {Array<object>} Resolved spans, in order along the road.
 */
export function resolveSpans(
  centreline,
  declarations,
  { heightAt, width = 9, profile, diagnostics } = {},
) {
  const out = [];
  if (!Array.isArray(declarations) || declarations.length === 0) return out;
  if (centreline.length < 4 || typeof heightAt !== 'function') return out;

  const crossSection = profile ?? buildTunnelProfile();
  const distances = cumulativeDistances(centreline);
  const laterals = lateralVectors(centreline);
  const total = distances[distances.length - 1];
  if (!(total > 0)) return out;

  const samples = centreline.map((point, index) => ({
    x: point.x,
    y: point.y,
    z: point.z,
    terrain: heightAt(point.x, point.z),
    lateral: laterals[index],
    halfWidth: TUNNEL_PROFILE.halfWidth,
    crownHeight: 0,
  }));

  for (const declaration of declarations) {
    const type = declaration.type;
    if (type !== 'bridge' && type !== 'tunnel') continue;
    const options = { ...STRUCTURE_DEFAULTS[type], ...declaration };
    let windowLength = Math.min(options.length, total);
    if (windowLength < 20) continue;

    const fitAt = (index, aligned) =>
      signedFit(
        type,
        { ...samples[index], crownHeight: type === 'bridge' ? options.crown : 0 },
        aligned,
        crossSection,
        { heightAt, width },
      );

    /** Alignment height at a sample for a window, ignoring the crown. */
    const alignIn = (window) => {
      const y0 = centreline[window.start].y;
      const y1 = centreline[window.end].y;
      const d0 = distances[window.start];
      const d1 = distances[window.end];
      const span = d1 - d0 || 1;
      return (index) => lerp(y0, y1, (distances[index] - d0) / span);
    };

    /**
     * Two numbers per window, because they answer different questions.
     *
     * `mean` chooses WHERE the structure goes: a window centred on a hill has
     * more average cover than the same window pushed to one side, even though
     * both contain the summit. Without it, whichever window happened to contain
     * the summit first wins, the ridge sits at the edge of it, and the span then
     * runs into the growth limit still fifty metres underground.
     *
     * `max` decides WHETHER it is deep enough: one deep pocket of rock is what a
     * bore needs, and one deep gap is what a deck needs.
     */
    const fitIn = (window) => {
      const alignedAt = alignIn(window);
      let max = -Infinity;
      let sum = 0;
      const samples = window.end - window.start + 1;
      for (let i = window.start; i <= window.end; i++) {
        const fit = fitAt(i, alignedAt(i));
        if (fit > max) max = fit;
        sum += fit;
      }
      return { max, mean: sum / samples };
    };

    /**
     * Deepest point any window could offer, whether or not it was accepted.
     * `note()` records the refusal rather than pushing it straight away: a
     * window can be widened and taken again, and only the final outcome of the
     * declaration should be reported.
     */
    let bestScore = -Infinity;
    let rejection = null;
    const note = (reason) => {
      rejection = { type, reason, bestScore, minClearance: options.minClearance };
    };

    /**
     * A structure is fitted inside a search window and then grown out to the
     * ground. If the span reaches the window's edge while the alignment would
     * still have fitted just outside it, the feature is wider than the window and
     * the span would be clipped: the portal would land in the cut face at the
     * window's edge instead of in the hillside. Widening the window and taking
     * the whole decision again is what puts the portal where the road actually
     * leaves the ground.
     *
     * Three things keep this honest. The road itself is the limit — a window can
     * never be wider than the road it is drawn over. An explicitly placed
     * structure is never widened, because that would move it away from where it
     * was asked to go. And a widening pass that comes back worse is discarded in
     * favour of the clipped span from the narrower window, so this can only ever
     * improve on the single-window result.
     */
    const maxAttempts = Number.isFinite(declaration.at) ? 1 : 5;
    const maxWindowLength = Math.min(total, options.length * MAX_WINDOW_GROWTH);
    /** @type {object|null} Accepted, un-clipped span. */
    let span = null;
    /**
     * The first accepted-but-clipped span, kept as the fallback.
     *
     * The *first*, not the last: that is the structure the declared window alone
     * would have produced, so a widening pass that never comes back clean leaves
     * the result exactly as it was before widening existed. Widening can add to
     * the answer, never subtract from it.
     */
    let fallback = null;

    for (let attempt = 0; attempt < maxAttempts && !span; attempt++) {
      bestScore = -Infinity;
      rejection = null;

      let best = null;
      if (Number.isFinite(declaration.at)) {
        // An explicit request still has to fit; report the fit either way.
        const centre = clamp(declaration.at, 0, 1) * total;
        const half = windowLength / 2;
        const start = indexAtDistance(distances, Math.max(0, centre - half));
        const end = indexAtDistance(distances, Math.min(total, centre + half));
        if (end - start >= 2) best = { start, end };
      } else {
        for (let start = 0; start < centreline.length; start++) {
          const candidate = windowAt(distances, start, windowLength);
          if (!candidate) break;
          const { max, mean } = fitIn(candidate);
          bestScore = Math.max(bestScore, max);
          // Strictly greater, so the first (earliest) window wins a tie and the
          // result is deterministic for a given map.
          if (!best || mean > best.mean) best = { ...candidate, mean, max };
        }
      }
      if (!best) {
        note('no window fitted on this road');
        break;
      }

      const fit = fitIn(best);
      if (Number.isFinite(declaration.at)) bestScore = fit.max;
      if (Number.isFinite(declaration.at) && fit.max < options.minClearance) {
        console.warn(
          `[Road] The tunnel/bridge asked for at ${(declaration.at * 100).toFixed(0)}% of this road ` +
            `has only ${fit.max.toFixed(1)} m of ${type === 'tunnel' ? 'cover' : 'clearance'}, ` +
            `below the ${options.minClearance} m minimum. Placing it anyway, because it was asked for.`,
        );
      }
      if (!Number.isFinite(declaration.at) && fit.max < options.minClearance) {
        note(
          `the deepest point over any ${Math.round(windowLength)} m window is only ` +
            `${fit.max.toFixed(1)} m`,
        );
        break;
      }

      // Where the structure actually goes: grow outwards from the window's most
      // promising sample, and stop where the fit crosses zero. That point is the
      // one place the road comes out of the hill (tunnel) or meets the ground
      // (bridge), which is exactly where the portal or the abutment belongs — so
      // the structure's ends and the edge of the untouched terrain coincide and
      // there is no step to see.
      //
      // Measured against the WINDOW's design line throughout, so the walk cannot
      // move the yardstick it is being judged by. Applying the alignment afterwards
      // does change it slightly (it is redrawn between the span's own ends), which
      // is why the fit is re-checked below rather than assumed.
      const designLine = alignIn(best);
      let anchor = best.start;
      let anchorFit = -Infinity;
      for (let i = best.start; i <= best.end; i++) {
        const fit = fitAt(i, designLine(i));
        if (fit > anchorFit) {
          anchorFit = fit;
          anchor = i;
        }
      }

      // The walk is bounded by the window: growing past it would put the span
      // outside the stretch of road the alignment is drawn over, and the road
      // inside the span would then be its old graded self — free to poke into the
      // hill it was meant to run through. Reaching the edge is instead the signal
      // that the window was too small, and the window is widened below.
      let start = anchor;
      let end = anchor;
      // The grow test carries a small tolerance. The span's ends are where the fit
      // reaches zero, and a road sample is a sample, not the exact point the two
      // surfaces cross. Ten centimetres of headroom costs nothing geometrically.
      const GROW_MARGIN = 0.1;
      while (start > best.start && fitAt(start - 1, designLine(start - 1)) >= GROW_MARGIN) {
        start--;
      }
      while (end < best.end && fitAt(end + 1, designLine(end + 1)) >= GROW_MARGIN) {
        end++;
      }

      // Worst fit over the part that is actually covered, measured against the
      // same line the road will be given.
      let minFit = Infinity;
      for (let i = start; i <= end; i++) minFit = Math.min(minFit, fitAt(i, designLine(i)));
      if (!(minFit >= 0)) {
        note(`the covered stretch does not fit (worst ${minFit.toFixed(2)} m)`);
        break;
      }
      if (distances[end] - distances[start] < (options.minSpan ?? 0)) {
        note(`the fitted span is only ${(distances[end] - distances[start]).toFixed(0)} m long`);
        break;
      }

      const candidate = {
        type,
        /**
         * The span the structure is built over: the stretch where it actually fits.
         * Its two ends are the portal or the abutment — the place the road meets the
         * ground — which is also where the terrain has to stop being graded, so the
         * same two numbers drive the geometry and the cut-and-fill.
         */
        startIndex: start,
        endIndex: end,
        /**
         * The stretch the road is *straightened* over: the window the line was
         * fitted through, which always contains the span.
         *
         * They are not the same range, and conflating them was a real bug. The
         * alignment has to reach past the portals to meet the approach road, or the
         * road would step by however far the ground happened to be from the line at
         * the portal — and it has to *cover* the span, or the road inside the span
         * would not be the line the fit was measured against. Only the road is
         * straightened over the window; only the span is left ungraded.
         */
        alignment: { startIndex: best.start, endIndex: best.end },
        startDistance: distances[start],
        endDistance: distances[end],
        length: distances[end] - distances[start],
        /** Deepest fit over the searched window, in metres. */
        windowFit: fit.max,
        /** Mean fit over the searched window, in metres. */
        windowMeanFit: fit.mean,
        /** Worst fit over the covered stretch, in metres. Never negative. */
        minFit,
        crown: options.crown ?? 0,
        minClearance: options.minClearance,
      };

      // Did the span run into the window's edge with the alignment still fitting
      // outside it? Then the feature is wider than the window and the span is
      // clipped, so the window is widened and everything above is done again.
      const clippedStart =
        start === best.start &&
        best.start > 0 &&
        fitAt(best.start - 1, designLine(best.start - 1)) >= GROW_MARGIN;
      const clippedEnd =
        end === best.end &&
        best.end < centreline.length - 1 &&
        fitAt(best.end + 1, designLine(best.end + 1)) >= GROW_MARGIN;

      if (
        Number.isFinite(declaration.at) ||
        windowLength >= maxWindowLength ||
        (!clippedStart && !clippedEnd)
      ) {
        span = candidate;
        break;
      }

      fallback ??= candidate;
      windowLength = Math.min(maxWindowLength, windowLength * 1.7 + 60);
    }

    // Widening came back worse — the wider window lowered the design line until
    // the fit no longer cleared — so the clipped span is the best available.
    const resolved = span ?? fallback;
    if (!resolved) {
      if (rejection) diagnostics?.push(rejection);
      continue;
    }
    out.push(resolved);
  }

  return out;
}

/**
 * Replace a stretch of road's vertical alignment with a straight line between
 * its ends.
 *
 * Called for both types, and applied over the span's `alignment` range — the
 * window — rather than over the span itself. The range's two ends keep their
 * original height, so whichever way the range is chosen the road joins what it
 * meets with no step.
 *
 * @param {Array<{x:number,y:number,z:number}>} points Mutated in place.
 * @param {{startIndex:number, endIndex:number, alignment?:{startIndex:number, endIndex:number},
 *          crown?:number}} span
 */
export function applyAlignedProfile(points, span) {
  const { startIndex, endIndex } = span.alignment ?? span;
  const samples = endIndex - startIndex;
  if (samples < 2) return span;

  const section = points.slice(startIndex, endIndex + 1);
  const distances = cumulativeDistances(section);
  const total = distances[distances.length - 1] || 1;
  const y0 = points[startIndex].y;
  const y1 = points[endIndex].y;
  const crown = span.crown ?? 0;

  for (let k = 0; k <= samples; k++) {
    const s = distances[k] / total;
    // A sine crown: zero at both ends, maximum in the middle, and smooth where
    // it meets the road.
    points[startIndex + k].y = lerp(y0, y1, s) + crown * Math.sin(Math.PI * s);
  }

  return span;
}

/** Lowest clearance between the road and the ground over a span, in metres. */
export function clearanceOver(points, span, heightAt) {
  let lowest = Infinity;
  for (let i = span.startIndex; i <= span.endIndex; i++) {
    const point = points[i];
    lowest = Math.min(lowest, point.y - heightAt(point.x, point.z));
  }
  return lowest;
}

/** Lowest and mean depth of ground above the road over a span. */
export function coverOver(points, span, heightAt) {
  let lowest = Infinity;
  let total = 0;
  const samples = span.endIndex - span.startIndex + 1;
  for (let i = span.startIndex; i <= span.endIndex; i++) {
    const point = points[i];
    const cover = heightAt(point.x, point.z) - point.y;
    lowest = Math.min(lowest, cover);
    total += cover;
  }
  return { minCover: lowest, meanCover: total / samples };
}

/* ---------------------------- cross-sections ------------------------------ */

/**
 * A tunnel cross-section as a closed horseshoe: vertical walls up to
 * `wallHeight`, then an elliptical crown to `apex`.
 *
 * The first and last points are both on the ground, so the shell's feet land on
 * the road surface rather than hovering.
 *
 * @returns {Array<{x:number, y:number}>} Local (lateral, up) coordinates.
 */
export function buildTunnelProfile({
  halfWidth = TUNNEL_PROFILE.halfWidth,
  wallHeight = TUNNEL_PROFILE.wallHeight,
  apex = TUNNEL_PROFILE.apex,
  segments = 6,
} = {}) {
  const points = [{ x: -halfWidth, y: 0 }];
  if (wallHeight > 0) points.push({ x: -halfWidth, y: wallHeight });
  for (let i = 0; i <= segments; i++) {
    const angle = Math.PI - (i / segments) * Math.PI;
    points.push({
      x: Math.cos(angle) * halfWidth,
      y: wallHeight + Math.sin(angle) * (apex - wallHeight),
    });
  }
  if (wallHeight > 0) points.push({ x: halfWidth, y: wallHeight });
  points.push({ x: halfWidth, y: 0 });
  return points;
}

/**
 * Push every point of a closed profile outward from an origin by `distance`.
 * Used to draw a portal as a ring between the section and an offset copy of it.
 */
export function offsetProfile(profile, { origin = { x: 0, y: 0 }, distance = 1.6 } = {}) {
  return profile.map((point) => {
    const dx = point.x - origin.x;
    const dy = point.y - origin.y;
    const length = Math.hypot(dx, dy) || 1;
    return { x: point.x + (dx / length) * distance, y: point.y + (dy / length) * distance };
  });
}

/** A rectangular cross-section, top face at y = 0, used for bridge decks. */
export function buildBoxProfile(width, thickness) {
  const half = width / 2;
  return [
    { x: -half, y: 0 },
    { x: half, y: 0 },
    { x: half, y: -thickness },
    { x: -half, y: -thickness },
  ];
}

/* ------------------------------ sweep data -------------------------------- */

/**
 * Sweep a cross-section along a road centreline into raw geometry buffers.
 *
 * Pure: no Three.js types are touched, so the sweep everything else depends on
 * can be asserted directly in a unit test.
 *
 * Profile coordinates are (lateral, up): `x` is to the left of the direction of
 * travel, matching `buildRibbon` so the road ribbon and a deck built from the
 * same samples line up exactly.
 *
 * @param {Array<{x:number,y:number,z:number}>} centreline
 * @param {Array<{x:number,y:number}>} profile
 * @param {{startIndex?:number, endIndex?:number, loopProfile?:boolean}} [options]
 * @returns {{positions:Float32Array, indices:Uint32Array, vertexCount:number, sliceCount:number}}
 */
export function sweepProfile(
  centreline,
  profile,
  { startIndex = 0, endIndex = centreline.length - 1, loopProfile = false } = {},
) {
  const slices = Math.max(0, endIndex - startIndex + 1);
  const profileCount = profile.length;
  const positions = new Float32Array(slices * profileCount * 3);
  const quads = Math.max(0, profileCount - (loopProfile ? 0 : 1));

  let cursor = 0;
  for (let s = 0; s < slices; s++) {
    const index = startIndex + s;
    const current = centreline[index];
    const previous = centreline[Math.max(0, index - 1)];
    const next = centreline[Math.min(centreline.length - 1, index + 1)];

    let tx = next.x - previous.x;
    let tz = next.z - previous.z;
    const length = Math.hypot(tx, tz) || 1;
    tx /= length;
    tz /= length;
    const leftX = -tz;
    const leftZ = tx;

    for (let p = 0; p < profileCount; p++) {
      const point = profile[p];
      positions[cursor++] = current.x + leftX * point.x;
      positions[cursor++] = current.y + point.y;
      positions[cursor++] = current.z + leftZ * point.x;
    }
  }

  const indices = new Uint32Array(Math.max(0, slices - 1) * quads * 6);
  cursor = 0;
  for (let s = 0; s < slices - 1; s++) {
    for (let p = 0; p < quads; p++) {
      const next = (p + 1) % profileCount;
      const a = s * profileCount + p;
      const b = s * profileCount + next;
      const c = (s + 1) * profileCount + p;
      const d = (s + 1) * profileCount + next;
      indices[cursor++] = a;
      indices[cursor++] = c;
      indices[cursor++] = d;
      indices[cursor++] = a;
      indices[cursor++] = d;
      indices[cursor++] = b;
    }
  }

  return { positions, indices, vertexCount: slices * profileCount, sliceCount: slices };
}

/**
 * A flat ring between two profiles, in the local (lateral, up) plane.
 * The tunnel portal: a concrete surround around the opening.
 */
export function buildPortalRing(inner, outer) {
  const count = Math.min(inner.length, outer.length);
  const positions = new Float32Array(count * 2 * 3);
  const indices = new Uint32Array(count * 6);
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    positions[cursor++] = inner[i].x;
    positions[cursor++] = inner[i].y;
    positions[cursor++] = 0;
    positions[cursor++] = outer[i].x;
    positions[cursor++] = outer[i].y;
    positions[cursor++] = 0;
  }
  cursor = 0;
  for (let i = 0; i < count; i++) {
    const next = (i + 1) % count;
    const a = i * 2;
    const b = i * 2 + 1;
    const c = next * 2;
    const d = next * 2 + 1;
    indices[cursor++] = a;
    indices[cursor++] = c;
    indices[cursor++] = d;
    indices[cursor++] = a;
    indices[cursor++] = d;
    indices[cursor++] = b;
  }
  return { positions, indices };
}

/**
 * Pier positions under a bridge deck.
 *
 * A pier is only interesting where the deck is actually off the ground, so
 * stations with less than `minHeight` of clearance are dropped — those are the
 * embankments at either end, and a two-metre stub of concrete under them reads
 * as debris rather than structure.
 */
export function pierStations(centreline, span, { heightAt, spacing = 30, minHeight = 3.5 } = {}) {
  const stations = [];
  if (typeof heightAt !== 'function') return stations;

  const section = centreline.slice(span.startIndex, span.endIndex + 1);
  const distances = cumulativeDistances(section);
  const total = distances[distances.length - 1] || 1;
  const count = Math.max(1, Math.floor(total / spacing));

  for (let k = 0; k < count; k++) {
    const at = ((k + 0.5) / count) * total;
    const index = clamp(
      span.startIndex + indexAtDistance(distances, at),
      span.startIndex,
      span.endIndex,
    );
    const point = centreline[index];
    const ground = heightAt(point.x, point.z);
    const height = point.y - ground;
    if (height < minHeight) continue;

    const previous = centreline[Math.max(0, index - 1)];
    const next = centreline[Math.min(centreline.length - 1, index + 1)];
    stations.push({
      x: point.x,
      y: point.y,
      z: point.z,
      ground,
      height,
      yaw: Math.atan2(next.x - previous.x, next.z - previous.z),
    });
  }
  return stations;
}

/* ------------------------------ Three.js side ----------------------------- */

/** Materials for every structure mesh. */
export function createStructureMaterials() {
  // Every structure surface is drawn double-sided. Structures are seen from both
  // sides (inside a tunnel, under a bridge, from a hill above one) and a
  // reversed winding would silently make one of those views see-through. The
  // triangle count here is in the hundreds, so the cost is irrelevant.
  return {
    deck: new THREE.MeshStandardMaterial({
      color: 0x8e9195,
      roughness: 0.86,
      metalness: 0.05,
      side: THREE.DoubleSide,
    }),
    parapet: new THREE.MeshStandardMaterial({
      color: 0xc2c5c8,
      roughness: 0.7,
      metalness: 0.08,
      side: THREE.DoubleSide,
    }),
    pier: new THREE.MeshStandardMaterial({
      color: 0x9fa2a5,
      roughness: 0.9,
      metalness: 0.02,
      side: THREE.DoubleSide,
    }),
    tunnel: new THREE.MeshStandardMaterial({
      color: 0x707478,
      roughness: 0.94,
      metalness: 0.02,
      side: THREE.DoubleSide,
    }),
    portal: new THREE.MeshStandardMaterial({
      color: 0x9b9ea1,
      roughness: 0.82,
      metalness: 0.04,
      side: THREE.DoubleSide,
    }),
    // Unlit, so the ceiling lamps read as lamps and not as grey stripes.
    lamp: new THREE.MeshBasicMaterial({
      color: 0xffe6ac,
      toneMapped: false,
      side: THREE.DoubleSide,
    }),
  };
}

/** Wrap raw sweep buffers in a BufferGeometry with normals computed. */
export function geometryFromSweep(sweep, name = 'structure', material = null) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(sweep.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(sweep.indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}

const UP = new THREE.Vector3(0, 1, 0);

/** Build one instanced mesh from a list of yawed boxes. */
function buildBoxInstances(boxes, material, name) {
  if (boxes.length === 0) return null;
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.InstancedMesh(geometry, material, boxes.length);
  mesh.name = name;
  mesh.receiveShadow = true;
  const quaternion = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const matrix = new THREE.Matrix4();

  boxes.forEach((box, index) => {
    quaternion.setFromAxisAngle(UP, box.yaw ?? 0);
    position.set(box.x, box.y, box.z);
    scale.set(box.width, box.height, box.depth);
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(index, matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

/** yaw -> quaternion object accepted by `PhysicsWorld.addStaticBox`. */
function yawQuaternion(yaw) {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

/**
 * Portal vertices in world space.
 *
 * The ring geometry is authored flat in its own plane and placed with a
 * transform, which the renderer does for free but a collider cannot — colliders
 * take world-space vertices, so this is the same rotation applied by hand.
 */
function transformedRing(ring, point, yaw) {
  const out = new Float32Array(ring.positions.length);
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  for (let i = 0; i < ring.positions.length; i += 3) {
    // Three.js yaw is about +Y: x' = x cos + z sin, z' = -x sin + z cos.
    const x = ring.positions[i];
    const y = ring.positions[i + 1];
    const z = ring.positions[i + 2];
    out[i] = x * cos + z * sin + point.x;
    out[i + 1] = y + point.y;
    out[i + 2] = -x * sin + z * cos + point.z;
  }
  return out;
}

/** Yaw of the road at a centreline sample, for placing structure sections. */
function yawAt(centreline, index) {
  const previous = centreline[Math.max(0, index - 1)];
  const next = centreline[Math.min(centreline.length - 1, index + 1)];
  return Math.atan2(next.x - previous.x, next.z - previous.z);
}

/**
 * Draw and collide every structure on a road network.
 *
 * @param {object} options
 * @param {import('./RoadNetwork.js').RoadNetwork} options.roads
 * @param {import('../physics/PhysicsWorld.js').PhysicsWorld} [options.physics]
 * @param {string} [options.preset] Graphics preset name, which decides how many
 *   point lights a tunnel interior gets. See `TUNNEL_LIGHT_SPACING`.
 * @returns {{group:THREE.Group, materials:object, stats:object, colliders:object[], dispose:Function}}
 */
export function buildRoadStructures({ roads, physics = null, preset = 'low' } = {}) {
  const group = new THREE.Group();
  group.name = 'road-structures';
  const materials = createStructureMaterials();
  const colliders = [];
  const stats = { bridges: 0, tunnels: 0, piers: 0, meshes: 0, lights: 0 };
  const lightSpacing = TUNNEL_LIGHT_SPACING[preset] ?? TUNNEL_LIGHT_SPACING.low;

  const addMesh = (sweep, material, name) => {
    const mesh = geometryFromSweep(sweep, name, material);
    group.add(mesh);
    stats.meshes++;
    return mesh;
  };

  for (const road of roads?.roads ?? []) {
    for (const structure of road.resolvedStructures ?? []) {
      const context = {
        road,
        structure,
        group,
        materials,
        physics,
        colliders,
        stats,
        addMesh,
        lightSpacing,
      };
      if (structure.type === 'bridge') {
        stats.bridges++;
        buildBridge(context);
      } else {
        stats.tunnels++;
        buildTunnel(context);
      }
    }
  }

  return {
    group,
    materials,
    stats,
    colliders,
    dispose() {
      for (const child of [...group.children]) {
        child.geometry?.dispose();
        child.dispose?.();
      }
      group.clear();
      group.parent?.remove(group);
      for (const material of Object.values(materials)) material.dispose();
    },
  };
}

function buildBridge({ road, structure, group, materials, physics, colliders, stats, addMesh }) {
  const { centreline } = road;
  const span = { startIndex: structure.startIndex, endIndex: structure.endIndex };
  const deckWidth = road.width + 1.8;
  const thickness = DECK_THICKNESS;

  // 1. The deck: a closed box section with its top at road level, just under the
  //    road ribbon that provides the driving surface.
  addMesh(
    sweepProfile(centreline, buildBoxProfile(deckWidth, thickness), { ...span, loopProfile: true }),
    materials.deck,
    `${road.name}:bridge-deck`,
  );

  // 2. Parapets. These DO get colliders: a bridge you can drive through the
  //    barrier of is worse than no barrier at all.
  for (const side of [-1, 1]) {
    const lateral = side * (deckWidth / 2 - 0.55);
    const parapet = sweepProfile(
      centreline,
      [
        { x: lateral, y: 0 },
        { x: lateral, y: 1.05 },
      ],
      span,
    );
    addMesh(parapet, materials.parapet, `${road.name}:bridge-parapet`);
    if (physics && parapet.indices.length > 0) {
      colliders.push(
        physics.addTrimesh(parapet.positions, parapet.indices, { surface: 'asphalt', tag: 'mesh' }),
      );
    }
  }

  // 3. Piers, footings and the abutments that carry the deck onto solid ground.
  const stations = pierStations(centreline, structure, {
    heightAt: road.naturalHeightAt,
    spacing: 30,
  });
  const boxes = [];
  for (const station of stations) {
    const shaftHeight = station.height - thickness;
    const shaftY = station.y - thickness - shaftHeight / 2;
    boxes.push({
      x: station.x,
      y: shaftY,
      z: station.z,
      yaw: station.yaw,
      width: 1.7,
      height: shaftHeight,
      depth: 2.6,
    });
    boxes.push({
      x: station.x,
      y: station.ground + 0.6,
      z: station.z,
      yaw: station.yaw,
      width: 2.9,
      height: 1.2,
      depth: 3.6,
    });
    if (physics) {
      colliders.push(
        physics.addStaticBox(
          { x: 0.85, y: shaftHeight / 2, z: 1.3 },
          { x: station.x, y: shaftY, z: station.z },
          yawQuaternion(station.yaw),
          { surface: 'asphalt', tag: 'mesh' },
        ),
      );
    }
  }
  stats.piers += stations.length;

  for (const index of [structure.startIndex, structure.endIndex]) {
    const point = centreline[index];
    const ground = road.naturalHeightAt(point.x, point.z);
    // Sunk into the ground so the abutment cannot float if the terrain under it
    // is a fraction of a metre lower than the sample suggests.
    const base = Math.min(ground, point.y) - 1.5;
    const height = Math.max(2, point.y - base);
    const yaw = yawAt(centreline, index);
    boxes.push({
      x: point.x,
      y: base + height / 2,
      z: point.z,
      yaw,
      width: deckWidth + 1.4,
      height,
      depth: 3.0,
    });
    if (physics) {
      colliders.push(
        physics.addStaticBox(
          { x: (deckWidth + 1.4) / 2, y: height / 2, z: 1.5 },
          { x: point.x, y: base + height / 2, z: point.z },
          yawQuaternion(yaw),
          { surface: 'asphalt', tag: 'mesh' },
        ),
      );
    }
  }

  const piers = buildBoxInstances(boxes, materials.pier, `${road.name}:bridge-piers`);
  if (piers) group.add(piers);
}

function buildTunnel({
  road,
  structure,
  group,
  materials,
  physics,
  colliders,
  addMesh,
  stats,
  lightSpacing = 0,
}) {
  const { centreline } = road;
  const span = { startIndex: structure.startIndex, endIndex: structure.endIndex };
  const profile = buildTunnelProfile();

  // 1. The shell: walls and crown in one sweep, open at the bottom so the road
  //    ribbon stays the floor. The shell is a trimesh collider as well, so a car
  //    cannot leave through a wall or jump through the ceiling.
  const shell = sweepProfile(centreline, profile, span);
  addMesh(shell, materials.tunnel, `${road.name}:tunnel-shell`);
  if (physics && shell.indices.length > 0) {
    colliders.push(
      physics.addTrimesh(shell.positions, shell.indices, { surface: 'asphalt', tag: 'mesh' }),
    );
  }

  // 2. Ceiling lamps: a thin emissive strip down the apex, and — on any preset
  //    that can afford it — real point lights under it, so the interior is
  //    actually lit rather than merely painted with glow.
  addMesh(
    sweepProfile(centreline, buildLampProfile(), span),
    materials.lamp,
    `${road.name}:tunnel-lamps`,
  );
  addTunnelLights({ road, structure, group, stats, spacing: lightSpacing });

  // 3. A portal surround at each end. The ring is built in the local
  //    (lateral, up) plane, so it only needs the road's yaw at that sample.
  const surround = offsetProfile(profile, { origin: { x: 0, y: 2 }, distance: 1.7 });
  const ring = buildPortalRing(profile, surround);
  for (const index of [structure.startIndex, structure.endIndex]) {
    const mesh = geometryFromSweep(ring, `${road.name}:tunnel-portal`, materials.portal);
    const point = centreline[index];
    const yaw = yawAt(centreline, index);
    mesh.position.set(point.x, point.y, point.z);
    mesh.quaternion.setFromAxisAngle(UP, yaw);
    mesh.updateMatrix();
    group.add(mesh);
    if (physics && ring.indices.length > 0) {
      colliders.push(
        physics.addTrimesh(transformedRing(ring, point, yaw), ring.indices, {
          surface: 'asphalt',
          tag: 'mesh',
        }),
      );
    }
  }
}

/**
 * Place real point lights down a tunnel's apex.
 *
 * Spacing comes from the graphics preset, and the run is capped: a tunnel short
 * enough to need one light gets one, and a map with several tunnels spreads the
 * same budget over all of them rather than lighting each one to the hilt. The
 * light's own `distance` is set to a few spacings so the shader can cull it —
 * without that, every light in the world is evaluated on every lit fragment.
 */
function addTunnelLights({ road, structure, group, stats, spacing = 0 }) {
  if (!(spacing > 0) || stats.lights >= MAX_TUNNEL_LIGHTS) return 0;

  const { centreline } = road;
  const section = centreline.slice(structure.startIndex, structure.endIndex + 1);
  if (section.length < 2) return 0;

  const distances = cumulativeDistances(section);
  const total = distances[distances.length - 1] || 0;
  if (!(total > 0)) return 0;

  // `spacing` is a target: widening it is how the per-map budget is respected.
  const count = Math.max(1, Math.min(Math.round(total / spacing), MAX_TUNNEL_LIGHTS));
  const step = total / count;
  const reach = Math.max(step, spacing) * 2.4;
  const height = TUNNEL_PROFILE.apex - 0.35;
  let added = 0;

  for (let k = 0; k < count && stats.lights < MAX_TUNNEL_LIGHTS; k++) {
    const at = (k + 0.5) * step;
    const index = clamp(
      structure.startIndex + indexAtDistance(distances, at),
      structure.startIndex,
      structure.endIndex,
    );
    const point = centreline[index];
    // Warm sodium-ish lamp light, bright enough to read as lit at 15-25 m, and
    // decaying to nothing before it reaches the portal so the transition to
    // daylight is not a hard edge.
    const light = new THREE.PointLight(0xffd9a2, 45, reach, 2);
    light.position.set(point.x, point.y + height, point.z);
    light.name = `${road.name}:tunnel-light`;
    group.add(light);
    stats.lights++;
    added++;
  }

  return added;
}

function buildLampProfile() {
  const y = TUNNEL_PROFILE.apex - 0.12;
  return [
    { x: -0.35, y },
    { x: 0.35, y },
  ];
}
