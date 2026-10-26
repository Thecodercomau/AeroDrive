import { clamp } from '../utilities/math.js';

/**
 * Minimap renderer.
 *
 * North-up, centred on the player, drawn with the 2D canvas API. Roads and
 * landmarks come from the built `World`, so the minimap can never disagree with
 * the map the player is actually driving on.
 *
 * Redrawn at a fixed low rate (see `HUD`), not every frame: the minimap changes
 * imperceptibly between frames and redrawing it is pure wasted CPU.
 */
export class Minimap {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.range = 520; // metres from edge to edge
    this.roads = [];
    this.landmarks = [];
    this.markers = [];
    this.bounds = { min: -1000, max: 1000 };
    this._background = null;

    const ratio = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
    this.size = canvas.width;
    canvas.width = this.size * ratio;
    canvas.height = this.size * ratio;
    this.ratio = ratio;
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.radius = this.size / 2;
  }

  /** Attach a built world. Precomputes the static road layer. */
  setWorld(world) {
    if (!world) {
      this.roads = [];
      this.landmarks = [];
      this._background = null;
      return;
    }
    this.roads = world.minimapRoads({ maxPointsPerRoad: 48 });
    this.landmarks = world.landmarks;
    this.bounds = world.bounds;
    this._background = this._renderBackground();
  }

  /** Extra dynamic markers (challenge checkpoints, traffic). */
  setMarkers(markers) {
    this.markers = markers ?? [];
  }

  /**
   * The static terrain rectangle, rendered once to an offscreen canvas.
   * Cheaper than stroking every road segment on every redraw.
   */
  _renderBackground() {
    const size = 160;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const span = this.bounds.max - this.bounds.min || 1;
    const toScreen = (x, z) => ({
      x: ((x - this.bounds.min) / span) * size,
      y: ((z - this.bounds.min) / span) * size,
    });

    ctx.fillStyle = 'rgba(24, 32, 41, 0.9)';
    ctx.fillRect(0, 0, size, size);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const road of this.roads) {
      ctx.beginPath();
      ctx.strokeStyle =
        road.surface === 'dirt' ? 'rgba(146, 120, 84, 0.85)' : 'rgba(150, 160, 172, 0.9)';
      ctx.lineWidth = clamp(road.width * 0.24, 1.2, 5);
      road.points.forEach((point, index) => {
        const screen = toScreen(point.x, point.z);
        if (index === 0) ctx.moveTo(screen.x, screen.y);
        else ctx.lineTo(screen.x, screen.y);
      });
      ctx.stroke();
    }
    return { canvas, toScreen, size };
  }

  /**
   * Draw the map around a position.
   * @param {object} params
   * @param {{x:number,z:number}} params.position
   * @param {number} params.heading Yaw in radians (0 = +Z).
   */
  render({ position, heading = 0 }) {
    const ctx = this.ctx;
    const size = this.size;
    ctx.clearRect(0, 0, size, size);

    // Clip to a circle so the HUD element reads as a gauge.
    ctx.save();
    ctx.beginPath();
    ctx.arc(this.radius, this.radius, this.radius - 2, 0, Math.PI * 2);
    ctx.clip();

    ctx.fillStyle = '#0e141b';
    ctx.fillRect(0, 0, size, size);

    if (this._background) {
      // Blit the whole-map layer scaled and positioned so the player sits at the
      // centre of the visible window.
      const worldSpan = this.bounds.max - this.bounds.min || 1;
      const scale = (this.range / worldSpan) * size;
      const offsetX = this.radius - ((position.x - this.bounds.min) / worldSpan) * size * scale;
      const offsetZ = this.radius - ((position.z - this.bounds.min) / worldSpan) * size * scale;
      ctx.save();
      ctx.translate(offsetX, offsetZ);
      ctx.drawImage(this._background.canvas, 0, 0, size * scale, size * scale);
      ctx.restore();
    }

    const toScreen = (x, z) => ({
      x: this.radius + ((x - position.x) / this.range) * size,
      y: this.radius + ((z - position.z) / this.range) * size,
    });

    // Landmarks
    for (const landmark of this.landmarks) {
      const screen = toScreen(landmark.x, landmark.z);
      if (screen.x < -20 || screen.y < -20 || screen.x > size + 20 || screen.y > size + 20)
        continue;
      ctx.beginPath();
      ctx.fillStyle = 'rgba(255, 209, 102, 0.95)';
      ctx.arc(screen.x, screen.y, 3.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Dynamic markers (checkpoints, mission targets)
    for (const marker of this.markers) {
      const screen = toScreen(marker.x, marker.z);
      ctx.beginPath();
      ctx.strokeStyle = marker.colour ?? 'rgba(255,90,31,0.95)';
      ctx.lineWidth = 2;
      ctx.arc(screen.x, screen.y, marker.radius ?? 5, 0, Math.PI * 2);
      ctx.stroke();
      if (marker.active) {
        ctx.fillStyle = marker.colour ?? 'rgba(255,90,31,0.35)';
        ctx.fill();
      }
    }

    // Player arrow, always centred and rotated to the heading.
    ctx.save();
    ctx.translate(this.radius, this.radius);
    // Heading 0 is +Z (up on the map), so rotate by -heading for screen space.
    ctx.rotate(-heading);
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(5.5, 6);
    ctx.lineTo(0, 3);
    ctx.lineTo(-5.5, 6);
    ctx.closePath();
    ctx.fillStyle = '#ff5a1f';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();

    ctx.restore();

    // Compass ring + cardinal ticks.
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(this.radius, this.radius, this.radius - 3, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = 'rgba(238,243,248,0.75)';
    ctx.font = `${Math.round(size * 0.075)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', this.radius, 11);
  }

  /** Fit the whole map in the widget (used in menus/summaries). */
  renderOverview() {
    const ctx = this.ctx;
    const size = this.size;
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#0e141b';
    ctx.fillRect(0, 0, size, size);
    if (this._background) ctx.drawImage(this._background.canvas, 0, 0, size, size);
  }
}
