/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

import { CamOp } from '../core/op.js';
import { Tool } from '../core/tool.js';
import { recordAreaSweep } from './stock.js';
import { newPolygon } from '../../../../geo/polygon.js';
import { newSlice } from '../../../core/slice.js';
import { newPoint } from '../../../../geo/point.js';

/**
 * Build the peck-cycle tool motion polyline for one drill point, mirroring
 * the gcode cycle emitted by prepare.js emitDrill(): successive peck
 * plunges of `down` each (the tail of one-to-two pecks split in half the
 * same way), with a retract of `lift` after every intermediate peck bottom.
 *
 * The shared recorder's stock-top filter drops retract vertices at or above
 * the stock surface, so retracts never remove material; re-plunges below it
 * pass through the already-cut well and fold in as no-ops (deepest
 * engagement wins per cell). Recording per peck step matters for deep
 * holes: the raster profile stamps the wall only up to the flute length
 * above the tip, so the stepwise tips tile the full well wall. The drill
 * profile's pointed tip leaves the matching pointed well bottom at each
 * step depth.
 *
 * @returns {Array} world-space {x,y,z} points, empty when there is no cut
 */
function drillCyclePoints(x, y, zTop, zBottom, down, lift) {
    let remain = zTop - zBottom;
    if (!(remain > 0)) {
        return [];
    }
    if (!(down > 0)) {
        down = remain;
    }
    const pts = [{ x, y, z: zTop }];
    let z = zTop;
    while (remain > down * 2) {
        // full peck: plunge `down` deeper, then retract (dwell is a
        // pause in place and does not affect the sweep)
        z -= down;
        remain -= down;
        pts.push({ x, y, z });
        if (lift > 0) {
            pts.push({ x, y, z: z + lift });
        }
    }
    if (remain >= down) {
        // tail of one-to-two pecks split into two half plunges
        z -= remain / 2;
        pts.push({ x, y, z });
        if (lift > 0) {
            pts.push({ x, y, z: z + lift });
        }
        z -= remain / 2;
    }
    pts.push({ x, y, z: zBottom });
    return pts;
}

class OpDrill extends CamOp {
    constructor(state, op) {
        super(state, op);
    }

    async slice(progress) {
        let { op, state } = this;
        let { color, settings, addSlices, widget, updateToolDiams, zBottom } = state;
        let { drills } = op

        let drillTool = new Tool(settings, op.tool),
            drillToolDiam = drillTool.fluteDiameter(),
            sliceOut = this.sliceOut = [];

        const allDrills = drills[widget.id] ?? []
        if (allDrills.length === 0) return;

        updateToolDiams(drillToolDiam);

        const sweepLines = [];

        // drill points to use center (average of all points) of the polygon
        allDrills.forEach((drill) => {
            if (!drill.selected) {
                return
            }

            let slice = newSlice(0);
            if (op.mark) {
                // replace depth with single down peck
                drill.depth = op.down
            }

            drill.zBottom = drill.z - drill.depth;

            // honor zBottom when set
            if (zBottom) drill.zBottom = Math.max(zBottom, drill.zBottom);

            // for thru holes, follow z thru when set
            if (op.thru > 0 && !op.mark) {
                drill.zBottom -= op.thru;
            }

            const poly = newPolygon()
            poly.points.push(newPoint(drill.x, drill.y, drill.z))
            poly.points.push(newPoint(drill.x, drill.y, drill.zBottom))

            slice.camTrace = { tool: op.tool, rate: op.feed, plunge: op.rate };
            slice.camLines = [poly];
            slice.output()
                .setLayer(state.layername, { face: color, line: color })
                .addPolys(slice.camLines);

            addSlices(slice);
            sliceOut.push(slice);

            // stock removal sweep: one peck-cycle polyline per drill point
            // (the slice camTrace poly is the bare top->bottom plunge used
            // for gcode emitDrill, which re-derives the peck steps itself)
            const cycle = drillCyclePoints(
                drill.x, drill.y, drill.z, drill.zBottom, op.down, op.lift);
            if (cycle.length > 1) {
                sweepLines.push(cycle);
            }
        });

        // record drill sweeps into the stock removal model: a cylinder of
        // the tool diameter swept to each peck depth leaves a stepped well
        // per point; retract vertices above the stock surface are dropped
        // by the recorder's z filter and never remove material
        recordAreaSweep(state, 'drill', {
            tool: op.tool,
            mode: op.mark ? 'mark' : 'drill',
            rename: op.rename ?? 'drill',
            thru: op.thru,
            down: op.down,
            lift: op.lift,
            dwell: op.dwell
        }, sweepLines);
    }

    prepare(ops, progress) {
        let { op, sliceOut } = this;
        let { setTool, setSpindle, setDrill, emitDrills } = ops;

        if (sliceOut.length === 0) return;

        setTool(op.tool, undefined, op.rate);
        setDrill(op.down, op.lift, op.dwell);
        emitDrills(sliceOut.map(slice => slice.camLines).flat());
    }
}

export { OpDrill };
