/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

import { CamOp } from '../core/op.js';
import { OpArea } from './op-area.js';
import { recordAreaSweep } from './stock.js';
import { newPolygon } from '../../../../geo/polygon.js';
import { polygons as POLY } from '../../../../geo/polygons.js';

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
            // skip regions prior operations already cleared (stock removal
            // model); defaults on for legacy op records lacking the field
            skipclear: op.skipclear !== false,
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
                // skipclear now works for flats: OpArea lowers the cleared
                // threshold to the bare cut plane (no leave_z) and strictly
                // below the stock top, so the leave_z skin flats exist to
                // shave is never classified as "already cleared" and virgin
                // cells at the stock top stay cuttable — only truly open
                // air (fully roughed regions) gets masked. flat_mask is
                // still gone (see #29d0debd history): the stock model's
                // per-cell clearedRegion is strictly more expressive
                skipclear: op.skipclear !== false,
                leave_xy: op.leave,
                leave_z: op.leavez,
                ov_botz: op.ov_botz,
                ov_topz: op.ov_topz,
                rotated: true,
                areas: { [widget.id]: areas.map(p => p.toArray()) },
                surfaces: {},
                flats,
                flatOff: 0.01
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
            // record this pass' material removal into the stock model
            this.recordStockSweep(op);
            bas += per;
        }
    }

    /**
     * Record one expanded OpArea pass (main clear, flats, cutout trace) into
     * the stock removal model. Delegates to the shared recordAreaSweep()
     * helper (stock.js) — see its docblock for the sweep semantics (profile
     * max-convolution, above-stock filtering, leave journaling, indexed
     * invalidation) and the omitthru/holes rationale.
     *
     * @param {OpArea} area a pass from ops_list, post-slice()
     */
    recordStockSweep(area) {
        recordAreaSweep(this.state, 'rough', area.op, area);
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
