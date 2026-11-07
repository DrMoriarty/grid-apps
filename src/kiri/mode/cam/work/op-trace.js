/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

import { CamOp } from '../core/op.js';
import { OpArea } from './op-area.js';
import { recordAreaSweep } from './stock.js';

class OpTrace extends CamOp {
    constructor(state, op) {
        super(state, op);
    }

    // todo: cut thru, wide steps

    async slice(progress) {
        let { op, state } = this;
        let { areas, direction, down, expand, follow, offover, offset, offz, outline, ignore, mode, ov_botz, ov_topz } = op;
        let { plunge, rate, refine, smooth, spindle, step, steps, thru, tolerance, tool } = op;
        let trace = {
            areas,
            direction,
            dogbones: op.dogbone,
            down,
            expand,
            follow,
            ignore,
            mode: mode === 'clear' ? 'clear' : 'trace',
            outline,
            ov_botz,
            ov_topz,
            over: op.step,
            plunge,
            rate,
            refine,
            rename: op.rename ?? "trace",
            revbones: op.revbone,
            smooth,
            spindle,
            step,
            surfaces: {},
            tolerance,
            tool,
            thru,
            tr_over: offover,
            tr_offz: offz,
            tr_type: offset
        };
        this.op_trace = new OpArea(state, trace);
        await this.op_trace.slice(progress);
        // record this pass' material removal into the stock model. all
        // trace types (none/inside/outside offsets, edge/surface
        // selections, clear mode) emit camLines with cut z already baked
        // in, so the shared recorder folds the tool profile along them.
        // traces hugging vertical walls sweep half the tool diameter to
        // each side of the centerline — the profile convolution covers
        // the wall cells on both sides (see StockModel.#stamp)
        recordAreaSweep(state, 'trace', trace, this.op_trace);
    }

    async prepare(ops, progress) {
        return this.op_trace.prepare(ops, progress);
    }
}

export { OpTrace };
