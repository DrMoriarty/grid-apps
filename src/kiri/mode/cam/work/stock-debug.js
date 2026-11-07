/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

/**
 * Debug visualization of the StockModel removed-top heightmap.
 *
 * Renders the model's grid as a field of small cross markers, one per grid
 * node (subsampled when the grid is huge), placed at the z of the remaining
 * material surface at that node. Color encodes depth of material removed:
 *
 *   blue  = untouched (marker sits at stock top, depth 0)
 *   red   = removed deepest (depth = stockTop - surface z)
 *
 * The normalization reference is the deepest removal anywhere in the grid,
 * so the heat spread always uses the full blue->red range for the current
 * toolpath run.
 *
 * The slice is added to the regular CAM slice output, so the layer appears
 * in the preview layer list ("stock.removed") and can be toggled like any
 * other named layer (same mechanism as the topo3.js "clip.tab" debug layer).
 * Generation is devel-gated at the call site (cam slice driver, mirroring
 * op-shadow.js) so normal UI runs never pay for it.
 *
 * Update policy: built ONCE per slice cycle, after all ops have recorded
 * their sweeps. Per-op incremental updates would re-render the whole layer
 * for no visual benefit during a run the user cannot interrupt anyway.
 */

import { newPoint } from '../../../../geo/point.js';
import { newPolygon } from '../../../../geo/polygon.js';
import { newSlice } from '../../../core/slice.js';

// hard cap on rendered markers: above this node count the grid is
// subsampled with a uniform stride (keeps codec/render cost bounded)
const MAX_MARKERS = 60000;

// number of heat color bands between untouched (blue) and deepest cut (red)
const HEAT_BANDS = 8;

/**
 * HSL (h in degrees, s/l in 0..1) -> packed 0xRRGGBB
 */
function hslToHex(h, s, l) {
    h /= 360;
    const f = n => {
        const k = (n + h * 12) % 12;
        const a = s * Math.min(l, 1 - l);
        const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
        return Math.round(v * 255);
    };
    return (f(0) << 16) | (f(8) << 8) | f(4);
}

/** band index t in 0..1 -> color, blue (240°) to red (0°) */
function heatColor(t) {
    return hslToHex(240 - 240 * t, 1, 0.5);
}

/**
 * Build the debug slice for a stock model.
 *
 * @param {StockModel} stockModel a model with recorded sweeps
 * @returns {Slice|null} slice with a single "stock.removed" layer, or null
 *   when the model is absent, invalid (rotary sweeps recorded) or carries
 *   no removable data
 */
export function stockDebugSlice(stockModel) {
    if (!stockModel || !stockModel.valid) {
        return null;
    }
    const { data, stepsX, stepsY, stockTop, resolution, minX, minY } = stockModel;
    if (!data || !data.length) {
        return null;
    }

    // deepest removal anywhere: heat normalization reference
    let maxDepth = 0;
    for (let i = 0; i < data.length; i++) {
        const depth = stockTop - data[i];
        if (depth > maxDepth) {
            maxDepth = depth;
        }
    }

    // uniform stride subsample to cap marker count
    const stride = Math.max(1, Math.ceil(Math.sqrt((stepsX * stepsY) / MAX_MARKERS)));

    // marker half-size and a tiny z lift to keep markers off the surface
    const half = resolution / 2;
    const lift = resolution * 0.05;

    // bucket markers by heat band so each band is a single addPolys()
    // call with one per-poly color (render groups by color)
    const bands = Array.from({ length: HEAT_BANDS }, () => []);

    for (let gx = 0; gx < stepsX; gx += stride) {
        for (let gy = 0; gy < stepsY; gy += stride) {
            const z = data[gx * stepsY + gy];
            const depth = stockTop - z;
            const band = maxDepth > 0
                ? Math.min(HEAT_BANDS - 1, Math.round((depth / maxDepth) * (HEAT_BANDS - 1)))
                : 0;
            const x = minX + gx * resolution;
            const y = minY + gy * resolution;
            const mz = z + lift;
            // plus-shaped open polygon: horizontal then vertical bar
            bands[band].push(newPolygon().addPoints([
                newPoint(x - half, y, mz),
                newPoint(x + half, y, mz),
                newPoint(x, y, mz),
                newPoint(x, y - half, mz),
                newPoint(x, y + half, mz)
            ]).setOpen());
        }
    }

    const debug = newSlice(-1);
    const output = debug.output();
    output.setLayer("stock.removed", { line: heatColor(0), opacity: 1 });
    let markers = 0;
    bands.forEach((polys, i) => {
        if (!polys.length) {
            return;
        }
        markers += polys.length;
        output.addPolys(polys, {
            thin: true,
            color: heatColor(i / (HEAT_BANDS - 1))
        });
    });

    console.log(`stock.removed debug layer: ${markers} markers` +
        (stride > 1 ? ` (stride ${stride})` : '') +
        `, max removal ${maxDepth.round(3)}mm`);

    return debug;
}
