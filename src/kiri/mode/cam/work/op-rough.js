/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

import { CamOp } from '../core/op.js';
import { OpArea, omitMatching } from './op-area.js';
import { newPolygon } from '../../../../geo/polygon.js';
import { polygons as POLY } from '../../../../geo/polygons.js';
import { util as base_util } from '../../../../geo/base.js';

class OpRough extends CamOp {
    constructor(state, op) {
        super(state, op);
    }

    // todo: cutThruBypass

    async slice(progress) {
        let { op, state } = this;
        let { newSlicer, shadow, stock, tool, widget } = state;

        let cutOutside = !op.inside;
        let shadowBase = shadow.base;

        if (op.down <= 0) {
            throw `invalid step down "${op.down}"`;
        }

        if (op.all) {
            shadowBase = [ newPolygon().centerRectangle(stock.center, stock.x, stock.y) ];
        }

        let areas = POLY.flatten(POLY.expand(shadowBase, tool.fluteDiameter() / 2 - 0.001));
        let ops_list = this.ops_list = [ ];

        // area polys of the main roughing pass, re-used for flats masking
        this.rough_areas = areas;

        ops_list.push(new OpArea(state, {
            rename: op.rename ?? "rough",
            spindle: op.spindle,
            direction: op.direction,
            tool: op.tool,
            rate: op.rate,
            plunge: op.plunge,
            mode: 'clear',
            over: op.step,
            down: op.down,
            expand: 0,
            smooth: 0,
            outline: true,
            omitthru: op.omitthru,
            leave_xy: op.leave,
            leave_z: op.leavez,
            ov_botz: op.ov_botz,
            ov_topz: op.ov_topz,
            rotated: true,
            spiral: op.spiral,
            spiral_finish: op.spiral_finish,
            areas: { [widget.id]: areas.map(p => p.toArray()) },
            surfaces: {}
        }));

        if (op.flats) {
            let slicer = newSlicer({ zflatup: true });
            let flats = Object.keys(slicer.zFlat).map(v => parseFloat(v)).sort((a,b) => b-a);
            // regions already cleared by the main roughing pass, per flat plane,
            // so the flats pass doesn't raster (and mill air) over them
            let flat_mask = await this.roughClearMask(flats);
            ops_list.push(new OpArea(state, {
                rename: op.rename ?? "flats",
                spindle: op.spindle,
                direction: op.direction,
                tool: op.tool,
                rate: op.rate,
                plunge: op.plunge,
                mode: 'clear',
                over: op.step,
                down: op.down,
                expand: 0,
                smooth: 0,
                outline: true,
                omitthru: op.omitthru,
                leave_xy: op.leave,
                leave_z: op.leavez,
                ov_botz: op.ov_botz,
                ov_topz: op.ov_topz,
                rotated: true,
                areas: { [widget.id]: areas.map(p => p.toArray()) },
                surfaces: {},
                flats,
                flatOff: 0.01,
                flat_mask
            }));
        }

        // outside only if we're not clearing all of stock
        if (cutOutside && !op.all) {
            if (op.leave) {
                // recompute area with offset when provided
                areas = POLY.flatten(POLY.expand(shadowBase, tool.fluteDiameter() / 2 - 0.001 + op.leave));
            }
            ops_list.push(new OpArea(state, {
                rename: op.rename ?? "cutout",
                spindle: op.spindle,
                direction: op.direction === 'climb' ? 'conventional' : 'climb',
                tool: op.tool,
                rate: op.rate,
                plunge: op.plunge,
                mode: 'trace',
                tr_type: 'none',
                down: op.down,
                expand: 0,
                smooth: 1,
                outline: !op.omitthru,
                ov_botz: op.ov_botz,
                ov_topz: op.ov_topz,
                rotated: true,
                areas: { [widget.id]: areas.map(p => p.toArray()) },
                surfaces: {},
                thru: true
            }));
        }

        let len = ops_list.length;
        let per = 1 / len;
        let bas = 0;
        for (let op of ops_list) {
            await op.slice(pct => progress(bas + pct * per));
            bas += per;
        }
    }

    /**
     * For each flat plane, compute the region already cleared by the main
     * roughing pass, so the flats pass can skip rastering through air.
     *
     * Both passes cut with the same tool and the same `area - shadow`
     * geometry, and both raise their paths by the same leavez, so material
     * at a flat's cut plane (f + flatOff) is already gone wherever the
     * first roughing layer at or below that plane swept. Roughing clears
     * `area - shadow(z+0.01)` at each descending layer and those cleared
     * regions nest (shadow grows downward), so the first qualifying
     * layer's clip covers everything cleared at or below it. The clip is
     * inset by the tool radius (+ leave) to match where the roughing tool
     * centerlines actually swept, leaving near-wall cleanup to the flats
     * pass as before.
     *
     * @returns {Object} map of flat cut plane (f + flatOff) to cleared Polygon[]
     */
    async roughClearMask(flats) {
        let { op, state } = this;
        let { shadowAt, stock, tool, workarea } = state;
        let leave = op.leave ?? 0;
        let flatOff = 0.01;
        let toolDiam = tool.fluteDiameter();
        // roughing layer planes (mirrors OpArea clear mode lerp)
        let zs = base_util.lerp(workarea.top_z, workarea.bottom_z, op.down);
        // roughing area polys (same as the main pass)
        let areas = this.rough_areas;
        let mask = {};
        for (let f of flats) {
            // first roughing layer at or below the flats cut plane
            let zr = zs.find(z => z <= f + flatOff);
            if (zr === undefined) {
                continue;
            }
            let shadow = await shadowAt(zr + 0.01);
            if (op.omitthru) {
                shadow = omitMatching(shadow, state.shadow.holes);
            }
            // clip of the main roughing pass at that layer
            let clip = [];
            POLY.subtract(areas, shadow, clip, undefined, undefined, 0);
            if (!clip.length) {
                continue;
            }
            // inset to where roughing tool centerlines swept
            let swept = POLY.offset(clip, -(toolDiam / 2 + leave), {
                count: 1,
                z: f + flatOff,
                clean: true,
                simple: false,
                minArea: 0.01
            });
            if (swept.length) {
                mask[f + flatOff] = swept;
            }
        }
        return mask;
    }

    async prepare(ops, progress) {
        let { ops_list } = this;
        let { setChangeOp } = ops;
        let len = ops_list.length;
        let per = 1 / len;
        let bas = 0;
        for (let op of ops_list) {
            await op.prepare(ops, pct => progress(bas + pct * per));
            bas += per;
            setChangeOp();
        }
    }
}

export { OpRough };
