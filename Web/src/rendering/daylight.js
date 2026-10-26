/**
 * Time of day.
 *
 * Everything here is pure arithmetic on a clock hour, so the whole cycle can be
 * unit tested without a renderer, a scene or a browser. `Environment` is the
 * only consumer: it turns this state into a sun, a sky gradient and a fog
 * colour.
 *
 * The model is deliberately a simple solar arc rather than an ephemeris:
 *
 *   - the sun rises in +X at 06:00, is highest at 12:00, sets in -X at 18:00,
 *     and is below the horizon between 18:00 and 06:00;
 *   - a small constant Z tilt keeps the light off-axis so shadows are never
 *     perfectly perpendicular to the terrain grid;
 *   - the sun's *elevation* drives a three-way blend between a night, a
 *     twilight and a day look, so dawn and dusk are a smooth gradient rather
 *     than a switch.
 *
 * Per-map identity is preserved: the `day` mood takes its sky and fog colours
 * from the map definition, and the other moods blend toward neutral.
 */

/** A clock hour is 0..24, where 9.5 is 09:30. */
export const HOURS_PER_DAY = 24;

/**
 * The three lighting moods the cycle blends between.
 *
 * `day` is intentionally *not* listed with fixed sky colours — it inherits them
 * from the map so a desert noon does not look like an alpine noon.
 */
const MOODS = {
  night: {
    sunColour: 0x2f4a8f,
    sunIntensity: 0.07,
    skyTop: 0x03050c,
    skyBottom: 0x0a1220,
    ambientIntensity: 0.16,
    fogColour: 0x080d16,
    sunSize: 0.35,
    stars: 1,
  },
  twilight: {
    sunColour: 0xff7a33,
    sunIntensity: 0.72,
    skyTop: 0x1b2a4d,
    skyBottom: 0xe0894a,
    ambientIntensity: 0.42,
    fogColour: 0x3c3a52,
    sunSize: 1.5,
    stars: 0.35,
  },
  day: {
    sunColour: 0xfff2d5,
    sunIntensity: 2.1,
    ambientIntensity: 0.9,
    sunSize: 1,
    stars: 0,
  },
};

/** Elevation (unit sine of the solar angle) at which the sun is on the horizon. */
export const HORIZON_ELEVATION = 0;

/** Colour used for the sky/fog when a map does not define its own. */
const FALLBACK_SKY = { top: 0x3f7fc4, bottom: 0xc9dced, sun: 0xfff2d5 };

/**
 * Normalised direction from the world to the sun at a given hour.
 *
 * @param {number} hour Clock hour, 0..24.
 * @returns {{x:number,y:number,z:number}} Unit vector. `y` is negative at night.
 */
export function sunDirectionAt(hour) {
  const angle = (wrapHour(hour) / HOURS_PER_DAY - 0.25) * Math.PI * 2;
  const x = Math.cos(angle);
  const y = Math.sin(angle);
  // A fixed tilt, normalised with the rest, so the light never runs exactly
  // along a world axis (which would make shadow acne worse and roads flat-lit).
  const tilt = -0.22;
  const length = Math.hypot(x, y, tilt) || 1;
  return { x: x / length, y: y / length, z: tilt / length };
}

/** Height of the sun above the horizon, -1 (nadir) to 1 (zenith). */
export function sunElevationAt(hour) {
  return sunDirectionAt(hour).y;
}

/**
 * Wrap an hour into [0, 24).
 * @param {number} hour
 */
export function wrapHour(hour) {
  if (!Number.isFinite(hour)) return 0;
  const wrapped = hour % HOURS_PER_DAY;
  return wrapped < 0 ? wrapped + HOURS_PER_DAY : wrapped;
}

/**
 * Advance the clock by a real-time step.
 *
 * @param {number} hour Current clock hour.
 * @param {number} dtSeconds Real seconds elapsed.
 * @param {number} dayLengthMinutes Real minutes for one full 24 h day.
 * @returns {number} The new clock hour, wrapped into [0, 24).
 */
export function advanceHour(hour, dtSeconds, dayLengthMinutes) {
  const minutes = Number.isFinite(dayLengthMinutes) && dayLengthMinutes > 0 ? dayLengthMinutes : 24;
  const hoursPerSecond = HOURS_PER_DAY / (minutes * 60);
  return wrapHour(hour + Math.max(0, dtSeconds) * hoursPerSecond);
}

/** Format an hour as a 24-hour clock string. */
export function formatClock(hour) {
  const wrapped = wrapHour(hour);
  const hours = Math.floor(wrapped);
  const minutes = Math.floor((wrapped - hours) * 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * Full lighting state for a moment in the day.
 *
 * @param {number} hour Clock hour.
 * @param {object} [map] Map definition supplying the daytime sky palette.
 * @returns {{
 *   hour:number, clock:string, elevation:number, direction:{x:number,y:number,z:number},
 *   sunColour:number, sunIntensity:number, sunSize:number,
 *   skyTop:number, skyBottom:number, fogColour:number,
 *   ambientIntensity:number, hemisphereSky:number, hemisphereGround:number,
 *   stars:number, isNight:boolean, headlightsRecommended:boolean,
 * }}
 */
export function daylightState(hour, map = null) {
  const wrapped = wrapHour(hour);
  const direction = sunDirectionAt(wrapped);
  const elevation = direction.y;

  const sky = map?.sky ?? FALLBACK_SKY;
  const fog = map?.fog?.colour ?? 0x9fb6cd;
  const daySun = sky.sun ?? FALLBACK_SKY.sun;

  // Three-way blend weights. `night` fades out as the sun approaches the
  // horizon, `day` fades in once it is meaningfully above it, and `twilight`
  // takes whatever is left — which is exactly the band around sunrise/sunset.
  const night = 1 - smoothstep(-0.16, 0.06, elevation);
  const day = smoothstep(0.1, 0.42, elevation);
  const twilight = Math.max(0, 1 - night - day);
  const total = night + twilight + day || 1;
  const w = { night: night / total, twilight: twilight / total, day: day / total };

  const daySkyTop = sky.top ?? FALLBACK_SKY.top;
  const daySkyBottom = sky.bottom ?? FALLBACK_SKY.bottom;

  return {
    hour: wrapped,
    clock: formatClock(wrapped),
    elevation,
    direction,
    sunColour: blendThree(MOODS.night.sunColour, MOODS.twilight.sunColour, daySun, w),
    sunIntensity: blendMood('sunIntensity', w),
    sunSize: blendMood('sunSize', w),
    skyTop: blendThree(MOODS.night.skyTop, MOODS.twilight.skyTop, daySkyTop, w),
    skyBottom: blendThree(MOODS.night.skyBottom, MOODS.twilight.skyBottom, daySkyBottom, w),
    fogColour: blendThree(MOODS.night.fogColour, MOODS.twilight.fogColour, fog, w),
    ambientIntensity: blendMood('ambientIntensity', w),
    // The hemisphere fill is tinted by the sky above and the ground below, which
    // is what stops a night scene looking like a day scene with the lights down.
    hemisphereSky: blendThree(MOODS.night.skyTop, MOODS.twilight.skyTop, daySkyTop, w),
    hemisphereGround: blendThree(MOODS.night.fogColour, MOODS.twilight.fogColour, fog, w),
    stars: blendMood('stars', w),
    isNight: elevation < -0.02,
    // Headlights are genuinely needed below ~0.12 elevation; the HUD can say so.
    headlightsRecommended: elevation < 0.12,
  };
}

/** Blend one numeric field of the three moods. */
function blendMood(field, w) {
  return (
    MOODS.night[field] * w.night + MOODS.twilight[field] * w.twilight + MOODS.day[field] * w.day
  );
}

/** Weighted blend of three packed RGB colours. */
export function blendThree(a, b, c, w) {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const cr = (c >> 16) & 0xff;
  const cg = (c >> 8) & 0xff;
  const cb = c & 0xff;
  const r = Math.round(ar * w.night + br * w.twilight + cr * w.day);
  const g = Math.round(ag * w.night + bg * w.twilight + cg * w.day);
  const bl = Math.round(ab * w.night + bb * w.twilight + cb * w.day);
  return (clamp255(r) << 16) | (clamp255(g) << 8) | clamp255(bl);
}

function clamp255(value) {
  return Math.max(0, Math.min(255, value));
}

/** Hermite smoothstep, matching the GLSL builtin. */
function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0 || 1)));
  return t * t * (3 - 2 * t);
}
