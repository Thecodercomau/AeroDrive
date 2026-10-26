import { clamp } from '../utilities/math.js';

/**
 * The world map.
 *
 * The minimap answers "what is around me"; this answers "where is everything".
 * It draws the *whole* map — every road, every landmark, every garage and
 * recovery point, the active challenge's gates, and the player — which is the
 * navigation display the minimap deliberately is not.
 *
 * Drawn on demand rather than per frame: it is a full-screen menu, so it only
 * needs to repaint when it is shown or the player's position changes materially.
 */

const COLOURS = {
  background: '#0b1117',
  outer: '#060a0e',
  bounds: 'rgba(255,255,255,0.08)',
  road: 'rgba(158, 168, 180, 0.85)',
  dirtRoad: 'rgba(146, 120, 84, 0.85)',
  landmark: '#ffd166',
  landmarkVisited: 'rgba(34,197,94,0.9)',
  service: {
    garage: '#38bdf8',
    fuel: '#f59e0b',
    recovery: '#a78bfa',
  },
  player: '#ff5a1f',
  marker: 'rgba(255,90,31,0.95)',
  markerDone: 'rgba(34,197,94,0.8)',
  label: 'rgba(238,243,248,0.82)',
};

/** Service glyphs, drawn into a small square badge. */
const SERVICE_GLYPH = { garage: 'G', fuel: 'F', recovery: 'R' };

export class WorldMap {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.data = null;

    const ratio = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
    this.ratio = ratio;
    this.width = canvas.width;
    this.height = canvas.height;
    canvas.width = this.width * ratio;
    canvas.height = this.height * ratio;
    canvas.style.aspectRatio = `${this.width} / ${this.height}`;
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

    // Square plot area, centred, with room for a border and labels.
    this.padding = 26;
    this.size = Math.min(this.width, this.height) - this.padding * 2;
    this.originX = (this.width - this.size) / 2;
    this.originY = (this.height - this.size) / 2;
  }

  /**
   * Supply the map to draw.
   *
   * @param {object|null} data
   * @param {{min:number,max:number}} [data.bounds]
   * @param {Array<{name:string,width:number,surface?:string,points:Array}>} [data.roads]
   * @param {Array<{id:string,name:string,x:number,z:number}>} [data.landmarks]
   * @param {Array<{id:string,name:string,type:string,x:number,z:number}>} [data.services]
   * @param {Array<{x:number,z:number,active?:boolean,colour?:string}>} [data.markers]
   * @param {Array<string>} [data.discovered] Discovered landmark ids.
   * @param {{x:number,z:number}|null} [data.position]
   * @param {number} [data.heading]
   */
  setData(data) {
    this.data = data;
    return this;
  }

  /** World position → canvas position. */
  _project(x, z) {
    const { min, max } = this.data.bounds;
    const span = max - min || 1;
    return {
      x: this.originX + ((x - min) / span) * this.size,
      y: this.originY + ((z - min) / span) * this.size,
    };
  }

  render() {
    const ctx = this.ctx;
    const { width, height } = this;
    ctx.clearRect(0, 0, width, height);

    ctx.fillStyle = COLOURS.outer;
    ctx.fillRect(0, 0, width, height);

    if (!this.data) {
      ctx.fillStyle = COLOURS.label;
      ctx.font = '14px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No map loaded', width / 2, height / 2);
      return;
    }

    // Plot area
    ctx.fillStyle = COLOURS.background;
    ctx.fillRect(this.originX, this.originY, this.size, this.size);

    this._drawGrid();
    this._drawRoads();
    this._drawServices();
    this._drawLandmarks();
    this._drawMarkers();
    this._drawPlayer();

    ctx.strokeStyle = COLOURS.bounds;
    ctx.lineWidth = 1;
    ctx.strokeRect(this.originX, this.originY, this.size, this.size);

    this._drawScaleBar();
  }

  /** A faint 500 m grid, so distances on the map are readable. */
  _drawGrid() {
    const ctx = this.ctx;
    const { min, max } = this.data.bounds;
    const step = 500;
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.lineWidth = 1;
    for (let value = Math.ceil(min / step) * step; value <= max; value += step) {
      const p = this._project(value, value);
      ctx.beginPath();
      ctx.moveTo(p.x, this.originY);
      ctx.lineTo(p.x, this.originY + this.size);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(this.originX, p.y);
      ctx.lineTo(this.originX + this.size, p.y);
      ctx.stroke();
    }
  }

  _drawRoads() {
    const ctx = this.ctx;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const road of this.data.roads ?? []) {
      if (road.points.length < 2) continue;
      ctx.beginPath();
      ctx.strokeStyle = road.surface === 'dirt' ? COLOURS.dirtRoad : COLOURS.road;
      // Road width in metres → pixels, so a highway reads as wider than a trail.
      const span = this.data.bounds.max - this.data.bounds.min || 1;
      ctx.lineWidth = clamp((road.width / span) * this.size, 1.2, 14);
      road.points.forEach((point, index) => {
        const screen = this._project(point.x, point.z);
        if (index === 0) ctx.moveTo(screen.x, screen.y);
        else ctx.lineTo(screen.x, screen.y);
      });
      ctx.stroke();
    }
  }

  _drawServices() {
    const ctx = this.ctx;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const service of this.data.services ?? []) {
      const screen = this._project(service.x, service.z);
      const colour = COLOURS.service[service.type] ?? COLOURS.service.garage;
      ctx.beginPath();
      ctx.fillStyle = colour;
      ctx.arc(screen.x, screen.y, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#06121c';
      ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.fillText(SERVICE_GLYPH[service.type] ?? 'G', screen.x, screen.y + 0.5);
    }
  }

  _drawLandmarks() {
    const ctx = this.ctx;
    const discovered = new Set(this.data.discovered ?? []);
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const landmark of this.data.landmarks ?? []) {
      const screen = this._project(landmark.x, landmark.z);
      const seen = discovered.has(landmark.id);
      ctx.beginPath();
      ctx.fillStyle = seen ? COLOURS.landmarkVisited : COLOURS.landmark;
      ctx.arc(screen.x, screen.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 1.2;
      ctx.stroke();

      ctx.fillStyle = COLOURS.label;
      // Nudge the label off the marker so it does not sit under the dot.
      ctx.fillText(landmark.name, screen.x + 9, screen.y);
    }
  }

  _drawMarkers() {
    const ctx = this.ctx;
    for (const marker of this.data.markers ?? []) {
      const screen = this._project(marker.x, marker.z);
      ctx.beginPath();
      ctx.strokeStyle = marker.active ? COLOURS.marker : COLOURS.markerDone;
      ctx.lineWidth = marker.active ? 3 : 2;
      ctx.arc(screen.x, screen.y, marker.active ? 11 : 7, 0, Math.PI * 2);
      ctx.stroke();
      if (marker.active) {
        ctx.fillStyle = 'rgba(255,90,31,0.25)';
        ctx.fill();
      }
    }
  }

  _drawPlayer() {
    const position = this.data.position;
    if (!position) return;
    const ctx = this.ctx;
    const screen = this._project(position.x, position.z);
    ctx.save();
    ctx.translate(screen.x, screen.y);
    // Heading 0 is +Z, which is down-screen on a north-up map.
    ctx.rotate(-(this.data.heading ?? 0));
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.lineTo(7, 8);
    ctx.lineTo(0, 4);
    ctx.lineTo(-7, 8);
    ctx.closePath();
    ctx.fillStyle = COLOURS.player;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  /** A scale bar sized to a round number of metres. */
  _drawScaleBar() {
    const ctx = this.ctx;
    const span = this.data.bounds.max - this.data.bounds.min || 1;
    const candidates = [100, 200, 250, 500, 1000, 2000];
    const target = span / 5;
    const metres = candidates.reduce(
      (best, value) => (Math.abs(value - target) < Math.abs(best - target) ? value : best),
      candidates[0],
    );
    const pixels = (metres / span) * this.size;
    const x = this.originX + 12;
    const y = this.originY + this.size - 14;

    ctx.strokeStyle = COLOURS.label;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + pixels, y);
    ctx.moveTo(x, y - 5);
    ctx.lineTo(x, y + 5);
    ctx.moveTo(x + pixels, y - 5);
    ctx.lineTo(x + pixels, y + 5);
    ctx.stroke();

    ctx.fillStyle = COLOURS.label;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(metres >= 1000 ? `${metres / 1000} km` : `${metres} m`, x, y - 7);
  }
}
